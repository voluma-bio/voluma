/**
 * Runs one run's plan to the end: the harness's own wiring of thread pool, task runtime,
 * tools and supervisor, so a host supplies only adapters (the stored record, the sandbox,
 * evidence, a model) and what a worker or check thread says and runs on (`RoleSpec` minus
 * its tools, which the harness fixes: bash, the task tools, thread messaging, and `segment_sam` when offered). Resume and a
 * first run are the same call; the recorder is built on the stored events by the host.
 */
import type { Folded } from "@voluma/contracts/fold";
import type { ClaimEndReason } from "@voluma/contracts/runner";
import type { RecordedPin } from "@voluma/contracts/workflow";
import type { WorkflowFiles } from "@voluma/contracts/workflow-files";
import type { RunLayout, ThreadLayout } from "./layout";
import type { MainThread } from "./main-thread";
import type { Evidence } from "./ports/evidence";
import type { Files } from "./ports/files";
import type { History } from "./ports/history";
import type { Sandbox } from "./ports/sandbox";
import type { Recorder } from "./recorder";
import { runStartPlan } from "./run-start";
import { type RoleSpec, supervisor } from "./supervisor";
import { type PlanTask, taskRuntime } from "./task-runtime";
import { supervisorThreadId } from "./thread-id";
import { threadLog } from "./thread-log";
import { threads } from "./threads";
import { bashTool } from "./tools/bash";
import { buildTools } from "./tools/registry";
import { taskTools } from "./tools/task-tools";
import { threadMessageTool } from "./tools/thread-message";

/**
 * What a worker or check thread is told and runs on; the harness adds its always-on tools.
 * `tools` names the optional tools its agent grants (`tools/registry.ts`).
 */
export type RunRole = Omit<RoleSpec, "tools"> & { tools?: readonly string[] };
export type { PlanTask };

export interface SuperviseRunOptions {
  runId: string;
  /** The plan computed from the user's selection; the main thread may adapt it (`run-start.ts`). */
  plan: readonly PlanTask[];
  /** The workflow's tasks and outputs, which the run-start change is built from. */
  workflow: WorkflowFiles;
  selectedOutputs?: readonly string[];
  /** The user's notes for the run. */
  notes?: string;
  /** Why the previous claim ended; absent on the run's first claim. Recorded as `claim.started`. */
  previousClaim?: ClaimEndReason;
  /** The workflow packages the run starts from, as recorded on the root's first event. */
  workflows: RecordedPin[];
  layout: RunLayout;
  recorder: Recorder;
  history: History;
  /** A thread's own sandbox (`sandboxSession.get`). */
  sandbox(threadId: string): Promise<Sandbox>;
  /** Called when a thread ends: destroys its sandbox (`sandboxSession.release`). */
  releaseSandbox(threadId: string): void;
  evidence: Evidence;
  /** The run's bucket, read and written host-side by `view_image` and `segment_sam`. */
  files: Files;
  main: MainThread;
  /** `notes`: the main thread's notes in force when the thread starts. */
  /** `model`: the one a resumed thread started on (`provider/id`), which it must keep. */
  worker(
    task: PlanTask,
    thread: ThreadLayout,
    notes: string | undefined,
    model: string | undefined,
  ): RunRole;
  check(
    task: PlanTask,
    thread: ThreadLayout,
    notes: string | undefined,
    model: string | undefined,
  ): RunRole;
  /** Whether a failed thread's error text says the model provider failed; see `SupervisorOptions`. */
  providerError?(error: string): boolean;
  /** Whether such an error means no redo can succeed: the run then fails at once; see `SupervisorOptions`. */
  providerFatal?(error: string): boolean;
  signal: AbortSignal;
}

export async function superviseRun(options: SuperviseRunOptions): Promise<Folded> {
  const { runId, layout, recorder, signal } = options;
  const rootThreadId = supervisorThreadId(runId);
  // A stored log means an earlier claim ran. `previousClaim` says why it ended; a run claimed
  // before the API recorded reasons has none, and its resume says only "restarted".
  const resumed = recorder.events().length > 0;
  // Not a derived id: each invocation of the root is a thread start of its own.
  recorder.emit(rootThreadId, "thread.started", {
    parentThreadId: null,
    kind: "supervisor",
    workflows: options.workflows,
  });
  recorder.emit(rootThreadId, "claim.started", {
    resumed,
    ...(options.previousClaim && { after: options.previousClaim }),
  });
  const plan = await runStartPlan({
    runId,
    rootThreadId,
    recorder,
    main: options.main,
    workflow: options.workflow,
    computed: options.plan,
    selectedOutputs: options.selectedOutputs,
    notes: options.notes,
    timeoutMs: 5 * 60_000,
    signal,
  });
  const pool = threads(
    {
      runId,
      recorder,
      history: options.history,
      sandbox: options.sandbox,
      release: options.releaseSandbox,
    },
    signal,
  );
  const runtime = taskRuntime({
    recorder,
    evidence: options.evidence,
    runId,
    layoutOf: layout.forThread,
    rootThreadId,
    plan,
    stopThread: (id) => {
      if (pool.started(id)) return pool.abort(id);
      // Cut off by an earlier claim and not resumed here: nothing runs to abort, so the stop is
      // stored as its end, or the next claim would resume a thread nobody wants (`supervisor.ts`).
      const open = threadLog(recorder.events()).threads.get(id);
      if (open && !open.end) recorder.emit(id, "thread.ended", { status: "cancelled" });
    },
  });
  const task = (id: string): PlanTask => {
    const found = plan.find((t) => t.id === id);
    if (!found) throw new Error(`${id} is not a task of the plan`);
    return found;
  };
  const tools = (
    kind: "worker" | "check",
    thread: ThreadLayout,
    granted: readonly string[] = [],
  ) => [
    bashTool(thread),
    ...taskTools(runtime, kind),
    threadMessageTool((from, to, text) => sup.message(from, to, text)),
    ...buildTools(granted, { layout: thread, files: options.files }),
  ];
  const sup = supervisor({
    runId,
    plan,
    runtime,
    recorder,
    threads: pool,
    main: options.main,
    worker: (id, threadId, notes, model) => {
      const thread = layout.forThread(threadId, (p) => runtime.cites(id, p));
      const role = options.worker(task(id), thread, notes, model);
      return { ...role, tools: tools("worker", thread, role.tools) };
    },
    check: (id, threadId, notes, model) => {
      const thread = layout.forThread(threadId, (p) => runtime.cites(id, p));
      const role = options.check(task(id), thread, notes, model);
      return { ...role, tools: tools("check", thread, role.tools) };
    },
    providerError: options.providerError,
    providerFatal: options.providerFatal,
    signal,
  });
  return sup.run();
}
