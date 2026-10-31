/**
 * Runs one run to the end: the harness's own wiring of the workflow's roles, thread pool, task
 * runtime, tools, sandboxes and run loop, so a host supplies only what holds keys and machines
 * (the stored record, evidence, a model, a way to create a sandbox, the gateway's token). Each
 * role's tools, system prompt and first messages come from the workflow definition, each thread's
 * sandbox from its layout (`specOf`), and the review-asset conversion runs in one more sandbox of
 * the same session. Resume and a first run are the same call; the recorder is built on the stored
 * events by the host.
 *
 * `superviseRun` returns at once with the loop's result and the two things the host orders at the
 * end of a run, which depend on why it ends (the lease, the report): `drain` the conversion queue,
 * `close` the sandboxes.
 */
import type { RunEvent } from "@voluma/contracts/events";
import type { Folded } from "@voluma/contracts/fold";
import type { ClaimEndReason } from "@voluma/contracts/runner";
import type { WorkflowPin } from "@voluma/contracts/workflow";
import type { WorkflowDefinition } from "@voluma/workflow/definition";
import { withImageRefs } from "./adapters/pi/image-refs";
import { runLayout, type SandboxLayout } from "./layout";
import { keepOutputs } from "./outputs-backup";
import type { Evidence } from "./ports/evidence";
import type { Files } from "./ports/files";
import type { History } from "./ports/history";
import type { Outputs } from "./ports/outputs";
import type { CreateSandbox } from "./ports/sandbox";
import type { Recorder } from "./recorder";
import { type ReviewAssetsWorker, reviewAssetsWorker } from "./review-assets";
import { type AgentRole, type LoopConfig, type ModelSetup, runLoop } from "./run-loop";
import { type SandboxSession, sandboxSession } from "./sandbox-session";
import { type Gateway, type SandboxSettings, specOf } from "./sandbox-specs";
import { type PlanTask, taskRuntime } from "./task-runtime";
import { threadIdOf } from "./thread-id";
import { threadLog } from "./thread-log";
import { threads } from "./threads";
import { buildTools } from "./tools/registry";

export type { LoopConfig, ModelSetup, PlanTask };

export interface SuperviseRunOptions {
  runId: string;
  /** The role files, skills and task files of the run's workflow snapshot. */
  definition: WorkflowDefinition;
  /** The plan computed from the user's selection; the run starts with it (the main agent may change it). */
  plan: readonly PlanTask[];
  /** The outputs the user selected (every output when absent) and their notes; the first messages carry both. */
  selectedOutputs: readonly string[] | undefined;
  notes: string | undefined;
  /** The R2 prefix of the run's read-only inputs (the scan). */
  inputPrefix: string;
  /** Why the previous claim ended; absent on the run's first claim. Recorded as `claim.started`. */
  previousClaim?: ClaimEndReason;
  /** The workflow packages the run starts from; the root's first event records each at the snapshot's commit. */
  workflows: WorkflowPin[];
  recorder: Recorder;
  history: History;
  evidence: Evidence;
  /** The run's bucket, read and written host-side by `view_image` and `read_file`. */
  files: Files;
  /** The run's `/outputs` as a whole: backed up when a correction starts, put back when one ends unfinished (`outputs-backup.ts`). */
  outputs: Outputs;
  /**
   * The model, thinking level and call function of a thread of `role`. `recorded` is the model
   * (`provider/id`) a resumed thread started on, which it must keep.
   */
  model(role: AgentRole, recorded: string | undefined): ModelSetup;
  /** Makes a sandbox; the host meters it and picks the provider. `signal` stops a creation. */
  createSandbox: CreateSandbox;
  /** Size and lifetime of every sandbox. */
  sandbox: Omit<SandboxSettings, "runId">;
  /**
   * The gateway URL and token for the sandbox of that name (`SandboxLayout.name`). Present: the
   * roles that hold `segment_sam` get the tool and their sandboxes the gateway. Absent: no role
   * holds `segment_sam`.
   */
  gateway?(sandbox: string): Gateway | undefined;
  config?: Partial<LoopConfig>;
  /** Whether a failed thread's error text says the model provider failed. */
  providerError?(error: string): "retry" | "fatal" | undefined;
  log(line: string): void;
  /** Ends the run: its threads stop where they are. */
  signal: AbortSignal;
  /**
   * Ends the review-asset conversion and its sandbox creation. A stop that will not end the run
   * fires it; `signal`, which the host also fires when the run ends normally, must not, since
   * the conversion outlives it until `drain`.
   */
  conversionSignal: AbortSignal;
}

export interface Supervised {
  /** The loop's result: the run's fold, or the error that failed it. */
  result: Promise<Folded>;
  /**
   * For a run that has ended: waits until every output has an `assets.*` event, up to
   * `timeoutMs`, and records `assets.failed` for the rest (`ReviewAssetsWorker.drain`).
   */
  drain(timeoutMs: number): Promise<void>;
  /** Stops the conversion and destroys every sandbox. */
  close(): Promise<void>;
}

/**
 * The tools each role holds: its file's list, less `segment_sam` where it cannot be used. That
 * needs the gateway and a sandbox that produces results: one with `/outputs` writable. A role
 * that only inspects (its `/outputs` is read-only) never holds it: it does not redo the task.
 */
function grantsOf(def: WorkflowDefinition, gateway: boolean): Record<AgentRole, readonly string[]> {
  return Object.fromEntries(
    Object.values(def.agents).map(({ name, tools, sandbox, outputs }) => {
      const analyses = sandbox !== "none" && outputs === "write";
      return [name, tools.filter((t) => t !== "segment_sam" || (gateway && analyses))];
    }),
  );
}

const ROOT_NAME = "supervisor";

/** The run's root thread: the one its log already holds (an older run's id is not minted), else the id a new run mints. */
export const rootThreadOf = (runId: string, log: readonly RunEvent[]) =>
  threadLog(log).root.id ?? threadIdOf(runId, ROOT_NAME);

export function superviseRun(options: SuperviseRunOptions): Supervised {
  const { runId, recorder, definition, signal } = options;
  const rootThreadId = rootThreadOf(runId, recorder.events());
  const grants = grantsOf(definition, options.gateway !== undefined);
  const copyInputs = new Set(definition.files.tasks.filter((t) => t.copyInputs).map((t) => t.id));
  const layout = runLayout({
    runId,
    inputPrefix: options.inputPrefix,
    skills: definition.skills,
    agents: definition.agents,
    grants,
    // From the workflow's task, so a task the main agent adds from it keeps the flag.
    copiesInputs: (id) => copyInputs.has(id),
  });
  const recordOf = (threadId: string) => {
    const record = threadLog(recorder.events()).threads.get(threadId);
    if (!record) throw new Error(`${threadId} has no thread.started`);
    return record;
  };

  // The sandboxes of the run: one per thread, and the review-asset converter's. A thread's
  // `thread.started` is stored before its first sandbox call, so its layout is found by id.
  const CONVERT = `${runId}.convert`;
  const sandboxLayout = (id: string): SandboxLayout =>
    id === CONVERT ? layout.convert : layout.forThread(recordOf(id));
  const settings = { runId, ...options.sandbox };
  const session: SandboxSession = sandboxSession(
    (id) => {
      const sandbox = sandboxLayout(id);
      const gateway = sandbox.gateway ? options.gateway?.(sandbox.name) : undefined;
      // The conversion outlives `signal` (see `conversionSignal`); its own signal also carries the worker's halt.
      return options.createSandbox(
        specOf(sandbox, settings, gateway),
        id === CONVERT ? conversion.signal : signal,
      );
    },
    // The convert sandbox writes no event: a failure there shows as the file's `assets.failed`,
    // not as a failed sandbox on the main agent's page.
    (id, state, detail) => {
      if (id !== CONVERT)
        recorder.emit(id, "sandbox", { name: sandboxLayout(id).name, state, detail });
    },
    // The convert sandbox's commands run with `note: false`, so its note is never read.
    (id) => (id === CONVERT ? "" : layout.forThread(recordOf(id)).restartNote),
  );
  const conversion: ReviewAssetsWorker = reviewAssetsWorker({
    runId,
    rootThreadId,
    recorder,
    sandbox: () => session.get(CONVERT, { note: false }),
    signal: options.conversionSignal,
    log: options.log,
  });

  const result = (async (): Promise<Folded> => {
    // Not a derived id: each invocation of the root is a thread start of its own.
    recorder.emit(rootThreadId, "thread.started", {
      name: ROOT_NAME,
      parentThreadId: null,
      kind: "supervisor",
      workflows: options.workflows.map((pin) => ({ ...pin, commit: definition.commit })),
      sandboxImage: options.sandbox.image,
    });
    // A reopen clears the claim-end reason (`messages.ts`); a claim cut off before it wrote its
    // `claim.started` has one again, and says that instead. The schema's rule is
    // `resumed === (after !== undefined || reopened)`; deriving it here keeps the two in step,
    // and covers a claim cut off before any event reached the API (no log, but a `previousClaim`).
    const reopened = threadLog(recorder.events()).reopenPending && !options.previousClaim;
    recorder.emit(rootThreadId, "claim.started", {
      resumed: options.previousClaim !== undefined || reopened,
      ...(options.previousClaim && { after: options.previousClaim }),
      ...(reopened && { reopened }),
    });
    // Before any thread or sandbox: nothing may write or read `/outputs` while it is put back.
    await keepOutputs({
      runId,
      rootThreadId,
      recorder,
      outputs: options.outputs,
      mainWorks: layout.mainWorks,
      signal,
    });
    const pool = threads(
      {
        recorder,
        history: withImageRefs(options.history, options.files, runId, (id) => recordOf(id).name),
        sandbox: (id) => session.get(id),
        release: (id) =>
          session
            .release(id)
            .catch((e) => options.log(`releasing ${recordOf(id).name} failed: ${e}`)),
      },
      signal,
    );
    const runtime = taskRuntime({
      recorder,
      evidence: options.evidence,
      runId,
      layoutOf: layout.forThread,
      sandbox: (id, o) => session.get(id, o),
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
      layout,
      definition,
      selectedOutputs: options.selectedOutputs,
      notes: options.notes,
      model: options.model,
      grants,
      config: options.config,
      tools: (thread, names, agents) =>
        buildTools(names, {
          layout: thread,
          files: options.files,
          runtime,
          main: {
            rootThreadId,
            recorder,
            runtime,
            agents,
            subagents: definition.agents[thread.agent]?.subagents ?? [],
            workflow: definition.files,
          },
        }),
      providerError: options.providerError,
      signal,
    });
  })();

  return {
    result,
    drain: (timeoutMs) => conversion.drain(timeoutMs),
    close: async () => {
      await Promise.all([conversion.close(), session.close()]);
    },
  };
}
