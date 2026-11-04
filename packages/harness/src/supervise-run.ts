/**
 * Runs one run to the end: the harness's own wiring of the workflow's roles, thread pool, tools,
 * sandboxes and agent loop, so a host supplies only what holds keys and machines
 * (the stored record, a model, a way to create a sandbox, the gateway's token). Each
 * role's tools, system prompt and first messages come from the workflow definition, each thread's
 * sandbox from its layout (`specOf`), and the review-asset conversion runs in one more sandbox of
 * the same session. Resume and a first run are the same call; the recorder is built on the stored
 * events by the host.
 *
 * The host passes one signal: a cut-off, "this will not end the run" (shutdown, a lost lease, the
 * server's stop). `superviseRun` returns at once; `result` settles with how the claim ended. On a
 * normal end (completed, or failed) the harness first drains the conversion queue, so every
 * output has an `assets.*` event whatever step failed, even the host's `prepare`. A cut-off, also
 * one that lands during the drain, records nothing permanent: the next claim resumes. `close`
 * destroys the sandboxes, which the host orders after the lease and the report.
 */

import { agentLog } from "@voluma/contracts/agents";
import type { RunEvent } from "@voluma/contracts/events";
import type { ClaimEndReason } from "@voluma/contracts/runner";
import type { WorkflowPin } from "@voluma/contracts/workflow";
import { OLDER_VERSION_MESSAGE, type WorkflowDefinition } from "@voluma/workflow/definition";
import { withImageRefs } from "./adapters/pi/image-refs";
import type { UserSender } from "./adapters/pi/start-thread";
import { BashRuntime } from "./bash-runtime";
import { errorText } from "./error-text";
import type { ProviderError } from "./failure-policy";
import { convertLayout, type SandboxLayout } from "./layout";
import type { LoopConfig, ModelSetup } from "./loop-config";
import { runLock } from "./loop-shell";
import type { RunBucket } from "./ports/bucket";
import type { History } from "./ports/history";
import type { CreateSandbox } from "./ports/sandbox";
import type { Recorder } from "./recorder";
import { failUnfinishedAssets, type ReviewAssetsWorker, reviewAssetsWorker } from "./review-assets";
import { agentLayouts, runAgents } from "./run-agents";
import { type SandboxSession, sandboxSession } from "./sandbox-session";
import { type Gateway, type SandboxSettings, specOf } from "./sandbox-specs";
import { ROOT_NAME, threadIdOf } from "./thread-id";
import { type Threads, threads } from "./threads";

/** The sender of a background command's notices. */
const BASH_NOTICE: UserSender = { kind: "runtime", notice: true };

export type { LoopConfig, ModelSetup, ProviderError };

/** How long threads get to end after a cut-off or `fail` before the result settles anyway. */
const WIND_DOWN_MS = 5_000;

/** What `prepare` returns: the workflow and what depends on its roles. */
export interface Prepared {
  /** The role files, skills and output catalog of the run's workflow snapshot. */
  definition: WorkflowDefinition;
  /**
   * The model, thinking level and call function of a thread of `role`. `recorded` is the model
   * (`provider/id`) a resumed thread started on, which it must keep.
   */
  model(role: string, recorded: string | undefined): ModelSetup;
}

export interface SuperviseRunOptions {
  runId: string;
  /**
   * The host's setup that can fail: loading the workflow, checking its roles' models, ending an
   * earlier claim's sandboxes. It runs inside the supervisor, so a failure here ends the run like
   * any other failure, with the conversion queue drained. No sandbox is created before it resolves.
   * `signal` aborts when the run is cut off or failed.
   */
  prepare(signal: AbortSignal): Promise<Prepared>;
  /** The outputs the user selected (every output when absent) and their notes; the first messages carry both. */
  selectedOutputs: readonly string[] | undefined;
  notes: string | undefined;
  /** The input whose completed review conversions this run can reuse. */
  inputId: string;
  /** The R2 prefix of the run's read-only inputs (the scan). */
  inputPrefix: string;
  /** Why the previous claim ended; absent on the run's first claim. Recorded as `claim.started`. */
  previousClaim?: ClaimEndReason;
  /** The workflow packages the run starts from; the root's first event records each at the snapshot's commit. */
  workflows: WorkflowPin[];
  recorder: Recorder;
  history: History;
  /** The run's bucket, read host-side by `read`; `report_output` publishes through it. */
  bucket: RunBucket;
  /** Makes a sandbox; the host meters it and picks the provider. `signal` stops a creation. */
  createSandbox: CreateSandbox;
  /** Size and lifetime of every sandbox. */
  sandbox: Omit<SandboxSettings, "runId">;
  /**
   * The gateway URL and token for the sandbox of that name (`SandboxLayout.name`). Present: the
   * roles that hold a gateway tool (`segment_sam`, `segment_plate`) get it and their sandboxes the
   * gateway. Absent: no role holds them.
   */
  gateway?(sandbox: string): Gateway | undefined;
  config?: Partial<LoopConfig>;
  /** Whether a failed thread's error says the model provider failed (`RunLoopOptions.providerError`). */
  providerError?(error: string): ProviderError | undefined;
  /** How long a normal end waits for the review assets still being converted. */
  drainMs: number;
  log(line: string): void;
  /** The cut-off: this will not end the run. Threads and the conversion stop where they are. */
  signal: AbortSignal;
}

/** How a claim ended. A run that ended is final; a cut-off one is resumed by the next claim. */
export type Outcome = { kind: "ended"; error?: string } | { kind: "cut-off" };

export interface Supervised {
  /** Settles once threads have ended (or `WIND_DOWN_MS` after a cut-off) and, on a normal end, the conversion queue has drained. */
  result: Promise<Outcome>;
  /**
   * Fails the run with this error, as a step error would: its threads stop and the run ends
   * `failed`. Returns false once `result` has settled, when it changes nothing.
   */
  fail(error: unknown): boolean;
  /** Stops the conversion and destroys every sandbox. */
  close(): Promise<void>;
}

/** What a run began on, read from its root's `thread.started`: the sandbox image. */
export interface Pin {
  image: string;
}

/**
 * The pin of a run, or undefined for a run with no log yet. The first claim's root decides and
 * every later one copies it, so a resumed run keeps its image. A log whose root is not the one
 * this version mints (`<runId>.supervisor`, an id from before ids were derived), or whose root
 * records no image, was made by an older Voluma: resuming it would mint a second root or change
 * its dependencies, so it is refused.
 */
export function pinOf(runId: string, log: readonly RunEvent[]): Pin | undefined {
  if (!log.some((e) => e.type === "thread.started" && e.payload.parentThreadId === null))
    return undefined;
  const root = threadIdOf(runId, ROOT_NAME);
  const first = log.find(
    (e) => e.type === "thread.started" && e.threadId === root && e.payload.sandboxImage,
  );
  if (first?.type !== "thread.started" || !first.payload.sandboxImage) {
    throw new Error(OLDER_VERSION_MESSAGE);
  }
  return { image: first.payload.sandboxImage };
}

export function superviseRun(options: SuperviseRunOptions): Supervised {
  const { runId, recorder, signal: cutOff } = options;
  const rootThreadId = threadIdOf(runId, ROOT_NAME);
  const CONVERT = `${runId}.convert`;
  // Ends the run's own threads: after `fail`, and once the loop has settled.
  const ending = new AbortController();
  const loopSignal = AbortSignal.any([cutOff, ending.signal]);
  let failure: string | undefined;
  let settled = false;

  // Everything that needs the workflow, the conversion worker included: it starts once `prepare`
  // has resolved. When `prepare` fails there is no worker, and the end records the outputs itself.
  let worker: ReviewAssetsWorker | undefined; // set once `prepare` has resolved
  const world = options.prepare(loopSignal).then((prepared) => {
    const { definition } = prepared;
    const layouts = agentLayouts({
      runId,
      inputPrefix: options.inputPrefix,
      recorder,
      definition,
      gateway: options.gateway !== undefined,
    });
    const convert = convertLayout({ runId, inputId: options.inputId, skills: definition.skills });
    // Created before the session factory: recovery requests the convert sandbox while the
    // worker is still constructing, so the factory must not read anything the worker returns.
    const convertHalt = new AbortController();
    const convertSignal = AbortSignal.any([cutOff, convertHalt.signal]);
    // The sandboxes of the run: one per thread, and the review-asset converter's.
    const sandboxLayout = (id: string): SandboxLayout =>
      id === CONVERT ? convert : layouts.sandboxOf(id);
    const settings = { runId, ...options.sandbox };
    const session: SandboxSession = sandboxSession(
      (id) => {
        const sandbox = sandboxLayout(id);
        const gateway = sandbox.gateway ? options.gateway?.(sandbox.name) : undefined;
        const spec = specOf(sandbox, settings, gateway);
        // Cache identity must follow the run's pinned image, including after a deploy.
        if (id === CONVERT) spec.env = { ...spec.env, VOLUMA_REVIEW_RUNTIME: spec.image };
        // The conversion outlives the loop: it stops on the cut-off or its own halt, not with `ending`.
        return options.createSandbox(spec, id === CONVERT ? convertSignal : loopSignal);
      },
      // The convert sandbox writes no event: a failure there shows as the file's `assets.failed`,
      // not as a failed sandbox on the main agent's page.
      (id, state, detail) => {
        if (id !== CONVERT)
          recorder.emit(id, "sandbox", { name: sandboxLayout(id).name, state, detail });
      },
      // The convert sandbox's commands run with `note: false`, so its note is never read.
      (id) => (id === CONVERT ? "" : layouts.sandboxOf(id).restartNote),
    );
    const conversion = reviewAssetsWorker({
      runId,
      inputId: options.inputId,
      rootThreadId,
      recorder,
      sandbox: () => session.get(CONVERT, { note: false }),
      signal: cutOff,
      halt: convertHalt,
      log: options.log,
    });
    worker = conversion;
    return { prepared, layouts, session, conversion };
  });
  world.catch(() => {}); // the loop and the end read its failure

  const loop = async (): Promise<void> => {
    const { prepared, layouts, session } = await world;
    const { definition } = prepared;
    // Not a derived id: each invocation of the root is a thread start of its own.
    recorder.emit(rootThreadId, "thread.started", {
      name: ROOT_NAME,
      parentThreadId: null,
      kind: "supervisor",
      harness: "agents", // overlap with older runners, see `threadStarted` in contracts
      workflows: options.workflows.map((pin) => ({ ...pin, commit: definition.commit })),
      sandboxImage: options.sandbox.image,
    });
    // A reopen clears the claim-end reason (`messages.ts`); a claim cut off before it wrote its
    // `claim.started` has one again, and says that instead. The schema's rule is
    // `resumed === (after !== undefined || reopened)`; deriving it here keeps the two in step,
    // and covers a claim cut off before any event reached the API (no log, but a `previousClaim`).
    const reopened = agentLog(recorder.events()).reopenPending && !options.previousClaim;
    recorder.emit(rootThreadId, "claim.started", {
      resumed: options.previousClaim !== undefined || reopened,
      ...(options.previousClaim && { after: options.previousClaim }),
      ...(reopened && { reopened }),
    });
    const bash = new BashRuntime({
      recorder,
      deliver: (id, text) => running.send(id, text, BASH_NOTICE),
      cutOff,
      log: options.log,
    });
    /** A thread whose sandbox the run is done with: its commands stop, then the sandbox goes. */
    const release = (id: string) =>
      session
        .release(id, () => bash.release(id))
        .catch((e) => options.log(`releasing ${layouts.nameOf(id)} failed: ${e}`));
    const running = threads(
      {
        recorder,
        history: withImageRefs(options.history, options.bucket, runId, layouts.nameOf),
        sandbox: (id) => session.get(id),
        // An agent keeps its sandbox between turns (the idle timeout ends it) and is released when
        // its loop says it really ended.
        release: (id) => {
          if (!layouts.keepsSandbox(id)) void release(id);
        },
      },
      loopSignal,
    );
    // An input to a thread that was not running carries the notices it missed.
    const pool: Threads = {
      ...running,
      start(spec) {
        const handle = running.start(spec);
        if (spec.input) {
          for (const text of bash.takeNotices(spec.threadId)) handle.send(text, BASH_NOTICE);
        }
        return handle;
      },
    };
    // Before any thread resumes: the commands the last claim left running are over.
    await bash.endCutOff();
    await runAgents({
      runId,
      rootThreadId,
      recorder,
      definition,
      forAgent: layouts.forAgent,
      model: prepared.model,
      selectedOutputs: options.selectedOutputs,
      notes: options.notes,
      config: options.config,
      providerError: options.providerError,
      bucket: options.bucket,
      history: options.history,
      session,
      pool,
      bash,
      release,
      section: runLock(),
      signal: loopSignal,
    });
  };

  const result = (async (): Promise<Outcome> => {
    // A thread stuck in a slow call (creating a sandbox takes a minute) must not hold the end of
    // the run: WIND_DOWN_MS after the loop's signal fires, the result settles anyway.
    let timer: NodeJS.Timeout | undefined;
    const windDown = new Promise<void>((resolve) => {
      const arm = () => {
        timer = setTimeout(resolve, WIND_DOWN_MS);
      };
      if (loopSignal.aborted) arm();
      else loopSignal.addEventListener("abort", arm, { once: true });
    });
    let error: unknown;
    try {
      await Promise.race([loop(), windDown]);
    } catch (e) {
      error = e;
    } finally {
      ending.abort();
      clearTimeout(timer);
    }
    try {
      if (cutOff.aborted) return { kind: "cut-off" };
      // An error nobody caught (`fail`) is what ended the run, whatever the stopped loop threw.
      const reason = failure ?? (error === undefined ? undefined : errorText(error));
      const drained = worker
        ? await worker.drain(options.drainMs)
        : // `prepare` failed or never resolved: no worker, so the outputs are recorded here
          await failUnfinishedAssets(
            { runId, rootThreadId, recorder, signal: cutOff },
            reason ?? "the run's setup did not finish",
          );
      if (!drained) return { kind: "cut-off" };
      return reason === undefined ? { kind: "ended" } : { kind: "ended", error: reason };
    } catch (e) {
      // A store that gave up during the drain stops the run (the host's cut-off) before this.
      if (cutOff.aborted) return { kind: "cut-off" };
      return { kind: "ended", error: errorText(e) };
    } finally {
      settled = true;
    }
  })();

  return {
    result,
    fail(error) {
      if (settled) return false;
      failure ??= errorText(error);
      ending.abort();
      return true;
    },
    close: async () => {
      await world.then(
        ({ session, conversion }) => Promise.all([conversion.close(), session.close()]),
        () => {},
      );
    },
  };
}
