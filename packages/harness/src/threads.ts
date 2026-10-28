/**
 * The run's threads in one process: which are running and how to stop or steer them. It
 * keeps no run state beyond that. `start` launches a thread, or resumes one of the same id
 * from its History when given an `input`; the supervisor decides what to start and when,
 * from the stored log plus `running` (`supervisor.ts`). A thread that throws, or is refused
 * before it starts (`ran` false), is a failure of the run: `failure()` holds the first.
 */
import {
  type StartThreadOptions,
  startThread,
  type ThreadHandle,
  type UserSender,
} from "./adapters/pi/start-thread";

/** What differs per thread; the run-wide dependencies come from `Threads`' `shared`. */
type PerRun = "runId" | "recorder" | "history" | "sandbox" | "signal";
// Distributes over the kind union; a plain `Omit` would collapse it.
export type ThreadSpec = StartThreadOptions extends infer O
  ? O extends unknown
    ? Omit<O, PerRun>
    : never
  : never;
type Shared = Pick<StartThreadOptions, "runId" | "recorder" | "history" | "sandbox">;

export interface Threads {
  /** Starts a thread, or resumes one of the same id from its History (give it an `input`). */
  start(spec: ThreadSpec): ThreadHandle;
  running(threadId: string): boolean;
  /** Whether any thread is running. */
  active(): boolean;
  /** Steers a message into a running thread; false if it is not running or has ended. */
  send(threadId: string, text: string, sender: UserSender): boolean;
  /** Stops a running thread as cancelled. */
  abort(threadId: string): void;
  /** Stops every running thread. */
  abortAll(): void;
  /** Resolves once `threadId` is not running (at once if it is not). */
  idle(threadId: string): Promise<void>;
  /** Resolves once any running thread has ended (at once if none runs). */
  anyIdle(): Promise<void>;
  /** The first error a thread threw or was refused with. */
  failure(): unknown;
}

interface Entry {
  abort: AbortController;
  handle: ThreadHandle;
  running: boolean;
  /** Settles once `running` is false. */
  settled: Promise<void>;
}

export function threads(shared: Shared, signal?: AbortSignal): Threads {
  const entries = new Map<string, Entry>();
  let failure: unknown;

  function launch(spec: ThreadSpec): Entry {
    const abort = new AbortController();
    const stop = () => abort.abort();
    signal?.addEventListener("abort", stop);
    if (signal?.aborted) stop();
    const handle = startThread({ ...shared, ...spec, signal: abort.signal });
    const entry: Entry = { abort, handle, running: true, settled: Promise.resolve() };
    // `running` clears in the same tick `done` resolves: `send` refuses a moment before.
    entry.settled = handle.done
      .then(
        (outcome) => {
          if (!outcome.ran) {
            failure ??= new Error(
              `thread ${spec.threadId} did not run: ${outcome.error ?? "it had nothing to do"}`,
            );
          }
        },
        (error) => {
          failure ??= error;
        },
      )
      .finally(() => {
        entry.running = false;
        signal?.removeEventListener("abort", stop);
      });
    entries.set(spec.threadId, entry);
    return entry;
  }

  const live = () => [...entries.values()].filter((e) => e.running);

  return {
    start(spec) {
      if (entries.get(spec.threadId)?.running) {
        throw new Error(`thread ${spec.threadId} is already running`);
      }
      return launch(spec).handle;
    },
    running: (threadId) => entries.get(threadId)?.running === true,
    active: () => live().length > 0,
    send: (threadId, text, sender) => {
      const entry = entries.get(threadId);
      return entry?.running === true && entry.handle.send(text, sender);
    },
    abort: (threadId) => entries.get(threadId)?.abort.abort(),
    abortAll: () => {
      for (const entry of entries.values()) entry.abort.abort();
    },
    idle: (threadId) => entries.get(threadId)?.settled ?? Promise.resolve(),
    anyIdle: async () => {
      const running = live();
      if (running.length > 0) await Promise.race(running.map((e) => e.settled));
    },
    failure: () => failure,
  };
}
