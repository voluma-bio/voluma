/**
 * Runs one run to the end: the harness's own wiring of thread pool, task runtime, tools and
 * run loop, so a host supplies only adapters (the stored record, the sandbox, evidence, a
 * model) and what each role says and runs on (`RoleOf`, `Briefs`). Resume and a first run are
 * the same call; the recorder is built on the stored events by the host.
 */
import type { Folded } from "@voluma/contracts/fold";
import type { ClaimEndReason } from "@voluma/contracts/runner";
import type { RecordedPin } from "@voluma/contracts/workflow";
import type { WorkflowFiles } from "@voluma/contracts/workflow-files";
import type { RunLayout } from "./layout";
import type { Evidence } from "./ports/evidence";
import type { Files } from "./ports/files";
import type { History } from "./ports/history";
import type { Sandbox } from "./ports/sandbox";
import type { Recorder } from "./recorder";
import { type Briefs, LOOP_DEFAULTS, type LoopConfig, type RoleOf, runLoop } from "./run-loop";
import { type PlanTask, taskRuntime } from "./task-runtime";
import { supervisorThreadId } from "./thread-id";
import { threads } from "./threads";
import { buildTools } from "./tools/registry";

export type { RoleSetup } from "./run-loop";
export type { Briefs, LoopConfig, PlanTask, RoleOf };

export interface SuperviseRunOptions {
  runId: string;
  /** The plan computed from the user's selection; the run starts with it (the main agent may change it). */
  plan: readonly PlanTask[];
  /** The workflow's tasks and outputs, which the main agent adds tasks from. */
  workflow: WorkflowFiles;
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
  /** The run's bucket, read and written host-side by `view_image` and `read_file`. */
  files: Files;
  roles: { main: RoleOf; worker: RoleOf; check: RoleOf };
  briefs: Briefs;
  config?: Partial<LoopConfig>;
  /** Whether a failed thread's error text says the model provider failed. */
  providerError?(error: string): boolean;
  /** Whether such an error means no redo can succeed: the run then fails at once. */
  providerFatal?(error: string): boolean;
  signal: AbortSignal;
}

export async function superviseRun(options: SuperviseRunOptions): Promise<Folded> {
  const { runId, recorder, signal } = options;
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
    layoutOf: options.layout.forThread,
    rootThreadId,
    plan: options.plan,
    abortThread: (id) => {
      if (pool.started(id)) pool.abort(id);
    },
  });
  const maxFixRounds = options.config?.maxFixRounds ?? LOOP_DEFAULTS.maxFixRounds;
  return runLoop({
    runId,
    rootThreadId,
    recorder,
    runtime,
    threads: pool,
    layout: options.layout,
    roles: options.roles,
    briefs: options.briefs,
    config: options.config,
    tools: (thread, names, agents) =>
      buildTools(names, {
        layout: thread,
        files: options.files,
        runtime,
        main: {
          runId,
          rootThreadId,
          recorder,
          runtime,
          agents,
          workflow: options.workflow,
          maxFixRounds,
        },
      }),
    providerError: options.providerError,
    providerFatal: options.providerFatal,
    signal,
  });
}
