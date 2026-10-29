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
import type { RunLayout } from "./layout";
import type { MainThread } from "./main-thread";
import type { Evidence } from "./ports/evidence";
import type { Files } from "./ports/files";
import type { History } from "./ports/history";
import type { Sandbox } from "./ports/sandbox";
import type { Segmenter } from "./ports/segmenter";
import type { Recorder } from "./recorder";
import { runStartPlan } from "./run-start";
import { type RoleSpec, supervisor, supervisorThreadId } from "./supervisor";
import { type PlanTask, taskRuntime } from "./task-runtime";
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
  /** The run's sandbox for a thread (`sandboxSession.get`). */
  sandbox(threadId: string): Promise<Sandbox>;
  evidence: Evidence;
  /** Offers `segment_sam` to threads when set (the host has a Segmenter and a key for it). */
  segmenter?: Segmenter;
  /** The run's bucket, read and written host-side by `view_image` and `segment_sam`. */
  files: Files;
  main: MainThread;
  /** `notes`: the main thread's notes in force when the thread starts. */
  /** `model`: the one a resumed thread started on (`provider/id`), which it must keep. */
  worker(task: PlanTask, notes: string | undefined, model: string | undefined): RunRole;
  check(task: PlanTask, notes: string | undefined, model: string | undefined): RunRole;
  /** Whether a failed thread's error text says the model provider failed; see `SupervisorOptions`. */
  providerError?(error: string): boolean;
  /** Whether such an error means no redo can succeed: the run then fails at once; see `SupervisorOptions`. */
  providerFatal?(error: string): boolean;
  signal: AbortSignal;
}

export async function superviseRun(options: SuperviseRunOptions): Promise<Folded> {
  const { runId, layout, recorder, signal } = options;
  const rootThreadId = supervisorThreadId(runId);
  recorder.emit(rootThreadId, "claim.started", {
    resumed: options.previousClaim !== undefined,
    ...(options.previousClaim && { after: options.previousClaim }),
  });
  // Not a derived id: each invocation of the root is a thread start of its own.
  recorder.emit(rootThreadId, "thread.started", {
    parentThreadId: null,
    kind: "supervisor",
    workflows: options.workflows,
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
    { runId, recorder, history: options.history, sandbox: options.sandbox },
    signal,
  );
  const runtime = taskRuntime({
    recorder,
    evidence: options.evidence,
    runId,
    rootThreadId,
    plan,
    stopThread: (id) => pool.abort(id),
  });
  const task = (id: string): PlanTask => {
    const found = plan.find((t) => t.id === id);
    if (!found) throw new Error(`${id} is not a task of the plan`);
    return found;
  };
  const tools = (kind: "worker" | "check", granted: readonly string[] = []) => [
    bashTool(layout),
    ...taskTools(runtime, kind),
    threadMessageTool((from, to, text) => sup.message(from, to, text)),
    ...buildTools(granted, { layout, files: options.files, segmenter: options.segmenter }),
  ];
  const sup = supervisor({
    runId,
    plan,
    runtime,
    recorder,
    threads: pool,
    main: options.main,
    worker: (id, notes, model) => {
      const role = options.worker(task(id), notes, model);
      return { ...role, tools: tools("worker", role.tools) };
    },
    check: (id, notes, model) => {
      const role = options.check(task(id), notes, model);
      return { ...role, tools: tools("check", role.tools) };
    },
    providerError: options.providerError,
    providerFatal: options.providerFatal,
    signal,
  });
  return sup.run();
}
