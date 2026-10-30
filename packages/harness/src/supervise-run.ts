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
import { keepOutputs } from "./outputs-backup";
import type { Evidence } from "./ports/evidence";
import type { Files } from "./ports/files";
import type { History } from "./ports/history";
import type { Outputs } from "./ports/outputs";
import type { Sandbox } from "./ports/sandbox";
import type { Recorder } from "./recorder";
import { type Briefs, type LoopConfig, type RoleOf, runLoop } from "./run-loop";
import { type PlanTask, taskRuntime } from "./task-runtime";
import { supervisorThreadId } from "./thread-id";
import { threadLog } from "./thread-log";
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
  sandbox(threadId: string, options?: { note?: boolean }): Promise<Sandbox>;
  /** Called when a thread ends: destroys its sandbox (`sandboxSession.release`). */
  releaseSandbox(threadId: string): void;
  evidence: Evidence;
  /** The run's bucket, read and written host-side by `view_image` and `read_file`. */
  files: Files;
  /** The run's `/outputs` as a whole: backed up when a correction starts, put back when one ends unfinished (`outputs-backup.ts`). */
  outputs: Outputs;
  /** Resolves once no earlier claim's sandbox is live, throws if some are; awaited before a restore of `/outputs` (`outputs-backup.ts`). */
  earlierClaimsEnded(signal: AbortSignal): Promise<void>;
  roles: { main: RoleOf; worker: RoleOf; check: RoleOf };
  briefs: Briefs;
  config?: Partial<LoopConfig>;
  /** Whether a failed thread's error text says the model provider failed. */
  providerError?(error: string): boolean;
  /** Whether such an error means no redo can succeed: the run then fails at once. */
  providerFatal?(error: string): boolean;
  /**
   * A model reply that failed with no content on a transient error is a provider outage (the
   * call retry spent its budget; see `StartThreadOptions.providerOutage`). `release` lets the
   * host release the run; the host aborts `signal`, which cuts every thread off.
   */
  providerOutage?: { is(provider: string, error: string): boolean; release(error: string): void };
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
  // A reopen clears the claim-end reason (`messages.ts`); a claim cut off before it wrote its
  // `claim.started` has one again, and says that instead.
  const reopened = threadLog(recorder.events()).reopenPending && !options.previousClaim;
  recorder.emit(rootThreadId, "claim.started", {
    resumed,
    ...(options.previousClaim && { after: options.previousClaim }),
    ...(reopened && { reopened }),
  });
  // Before any thread or sandbox: nothing may write or read `/outputs` while it is put back.
  await keepOutputs({
    runId,
    rootThreadId,
    recorder,
    outputs: options.outputs,
    mainWorks: options.layout.mainWorks,
    earlierClaimsEnded: options.earlierClaimsEnded,
    signal,
  });
  const pool = threads(
    {
      runId,
      recorder,
      history: options.history,
      sandbox: options.sandbox,
      release: options.releaseSandbox,
      providerOutage: options.providerOutage,
    },
    signal,
  );
  const runtime = taskRuntime({
    recorder,
    evidence: options.evidence,
    runId,
    layoutOf: options.layout.forThread,
    sandbox: options.sandbox,
    rootThreadId,
    plan: options.plan,
    abortThread: (id) => {
      if (pool.started(id)) pool.abort(id);
    },
  });
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
        },
      }),
    providerError: options.providerError,
    providerFatal: options.providerFatal,
    signal,
  });
}
