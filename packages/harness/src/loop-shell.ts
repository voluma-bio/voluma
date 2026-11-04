/**
 * The skeleton of the run loop: the wake-up counter, starting a thread (its
 * `thread.started` is stored before it runs), the failure policy (a step error, a thread
 * refused or thrown, or a store that gave up fails the run on purpose), the drive loop, the
 * stop of every thread when the run ends, and the root's closing `thread.ended`. A loop supplies
 * what it decides (`step`) and how it reads the log; it keeps no state the shell holds.
 */

import type { UserSender } from "@voluma/contracts/thread-records";
import type { BashRuntime } from "./bash-runtime";
import type { ProviderError } from "./failure-policy";
import type { ThreadLayout } from "./layout";
import type { LoopConfig, ModelSetup } from "./loop-config";
import type { Files } from "./ports/files";
import type { History } from "./ports/history";
import type { Publish } from "./ports/publish";
import type { PayloadOf, Recorder } from "./recorder";
import type { SandboxSession } from "./sandbox-session";
import type { ThreadSpec, Threads } from "./threads";

/** The sender of every line the loop itself writes to a thread. */
export const RUNTIME: UserSender = { kind: "runtime" };

/** What a step found: something done, nothing to do until the log changes, or the run is over. */
export type Step = "acted" | "idle" | "done";

/** The per-run critical section: decisions run one at a time, each seeing every earlier write. */
export type Section = <T>(fn: () => Promise<T>) => Promise<T>;

export function runLock(): Section {
  let tail: Promise<unknown> = Promise.resolve();
  return (fn) => {
    const result = tail.then(fn);
    tail = result.catch(() => {});
    return result;
  };
}

/** What the shell hands a loop: the run's parts it built, and the host's settings it passes through. */
export interface Shared {
  runId: string;
  rootThreadId: string;
  recorder: Recorder;
  /** The model, thinking level and call function of a thread of `role` (`recorded`: the model a resumed thread started on). */
  model(role: string, recorded: string | undefined): ModelSetup;
  selectedOutputs: readonly string[] | undefined;
  notes: string | undefined;
  config?: Partial<LoopConfig>;
  providerError?(error: string): ProviderError | undefined;
  files: Files;
  /** The agents' stored conversations (`agents/transcript.ts` renders one). */
  history: History;
  /** Moves a file an agent named into a published output version (the agent loop's). */
  publish: Publish;
  session: SandboxSession;
  pool: Threads;
  /** The claim's background commands (`bash-runtime.ts`), built once for every loop. */
  bash: BashRuntime;
  /** Stops a thread's background commands and releases its sandbox (a loop calls it for an agent that has really ended). */
  release(threadId: string): Promise<void>;
  /** The run's one lock. */
  section: Section;
  signal: AbortSignal;
}

/**
 * The agent loop's side of a run (`agents/wire.ts`): which sandbox and display name each thread has,
 * read from the log, and the loop itself, run on the shell's parts.
 */
export interface Wire {
  /** A thread's sandbox; its `thread.started` is stored before its first sandbox call. */
  sandboxOf(threadId: string): ThreadLayout;
  nameOf(threadId: string): string;
  /** The thread's sandbox outlives its thread's turn: the shell releases it when the loop says so, not at each end. */
  keepsSandbox(threadId: string): boolean;
  run(shared: Shared): Promise<void>;
}

/** How long the main agent gets to end its turn after the run ended. */
const MAIN_GRACE_MS = 15_000;

export interface LoopShellOptions {
  rootThreadId: string;
  recorder: Recorder;
  threads: Threads;
  /** The per-run critical section: each step, and each stop of a thread, runs inside it. */
  section: Section;
  /** Runs once before the first step. */
  startup(): Promise<unknown>;
  /** The log as the loop reads it: the main thread's id and every thread's record. */
  log(): {
    main?: string;
    root: { endedThisClaim: boolean };
    threads: ReadonlyMap<string, { id: string; end?: unknown }>;
  };
  /** Stores a thread's end as cancelled and aborts it; called inside `section`. */
  stop(threadId: string, eventId: string): Promise<unknown>;
  signal?: AbortSignal;
}

export interface LoopShell {
  /** Something changed: wakes the loop. */
  nudge(): void;
  /**
   * Appends the thread's `thread.started` (with `startedEventId`), then starts it, then nudges
   * when it settles and its end is stored. Call inside `section`: a stop cannot come between
   * the append and the start.
   */
  begin(
    start: ThreadSpec,
    startedPayload: PayloadOf<"thread.started">,
    startedEventId: string,
  ): Promise<void>;
  /** Drives `step` until the run ends, then stops every thread and closes the root. Throws the run's failure. */
  run(step: () => Promise<Step>): Promise<void>;
}

export function loopShell(o: LoopShellOptions): LoopShell {
  const { rootThreadId: root, recorder, threads, signal } = o;
  let failure: unknown;

  // A change of the run (a thread settled, a main tool wrote) wakes the loop; a change that
  // lands during a step is seen by the next one because the loop compares versions.
  let version = 0;
  let waiters: (() => void)[] = [];
  const nudge = () => {
    version++;
    for (const wake of waiters.splice(0)) wake();
  };
  async function sleep(seen: number) {
    if (version !== seen || signal?.aborted) return;
    await new Promise<void>((resolve) => {
      const done = () => {
        signal?.removeEventListener("abort", done);
        waiters = waiters.filter((w) => w !== done);
        resolve();
      };
      signal?.addEventListener("abort", done, { once: true });
      waiters.push(done);
    });
  }

  const fail = (error: unknown) => {
    failure ??= error;
    threads.abortAll();
  };

  /** Whether the run has failed: a step error, a thread refused or thrown, an event given up on. */
  function failed(): boolean {
    const cause = threads.failure() ?? recorder.failure();
    if (cause !== undefined) fail(cause);
    return failure !== undefined;
  }

  /**
   * Stores the end of every thread that has none (append-first), then aborts the running ones.
   * The main agent is left to finish its turn first (its close ended the run), so a finished run
   * does not show it as cancelled; it is stopped if it takes more than `MAIN_GRACE_MS`.
   */
  async function stopAll() {
    const stopThreads = (spare?: string) =>
      o.section(async () => {
        for (const r of o.log().threads.values()) {
          if (r.id !== spare && (!r.end || threads.running(r.id))) {
            await o.stop(r.id, `${root}:end:${r.id}`);
          }
        }
      });
    const main = o.log().main;
    await stopThreads(main && threads.running(main) ? main : undefined);
    if (main && threads.running(main)) {
      await Promise.race([threads.idle(main), new Promise((r) => setTimeout(r, MAIN_GRACE_MS))]);
      await recorder.flush();
      await stopThreads();
    }
  }

  async function begin(
    start: ThreadSpec,
    startedPayload: PayloadOf<"thread.started">,
    startedEventId: string,
  ) {
    await recorder.append(start.threadId, "thread.started", startedPayload, startedEventId);
    threads.start(start);
    void threads
      .idle(start.threadId)
      .then(() => recorder.flush())
      .then(nudge, nudge);
  }

  async function run(step: () => Promise<Step>) {
    try {
      if (!signal?.aborted) await o.startup();
      while (!signal?.aborted && !failed()) {
        const seen = version;
        const next = await o.section(step);
        if (next === "done") break;
        if (next === "acted") continue;
        await sleep(seen);
      }
      if (!signal?.aborted && !failed()) await stopAll();
    } catch (error) {
      fail(error);
    }
    while (threads.active()) await threads.anyIdle();
    await recorder.flush();
    failed();
    if (failure !== undefined) {
      const error = failure instanceof Error ? failure.message : String(failure);
      if (!signal?.aborted) recorder.emit(root, "thread.ended", { status: "failed", error });
      throw failure;
    }
    // A runtime abort writes no end, like a crash: the next claim resumes the root as well.
    if (!signal?.aborted && !o.log().root.endedThisClaim) {
      recorder.emit(root, "thread.ended", { status: "completed" });
    }
  }

  return { nudge, begin, run };
}
