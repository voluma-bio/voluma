/**
 * The run's threads in one process: who is running, who is idle, and how one thread
 * reaches another. `start` launches a thread (or resumes an idle one); `message` is what
 * the `thread_message` tool calls (`@voluma/contracts/thread-message`): a running target is
 * steered, an idle one is woken with the message as its input, and `wait` is allowed only
 * toward the sender's own children so two threads can never wait on each other. A wake from
 * a message goes through the supervisor's `onWake`, which may refuse it and watches the
 * thread it starts; the supervisor's own `resume` does not.
 */
import type { ThreadMessageResult } from "@voluma/contracts/thread-message";
import {
  type StartThreadOptions,
  startThread,
  type ThreadHandle,
  type ThreadOutcome,
} from "./adapters/pi/start-thread";

/** What differs per thread; the run-wide dependencies come from `Threads`' `shared`. */
export type ThreadSpec = Omit<
  StartThreadOptions,
  "runId" | "recorder" | "history" | "sandbox" | "signal"
>;
type Shared = Pick<StartThreadOptions, "runId" | "recorder" | "history" | "sandbox">;

export interface Threads {
  /** Starts a thread, or resumes an idle one of the same id from its History. */
  start(spec: ThreadSpec): ThreadHandle;
  /** Wakes the idle thread `threadId`: another invocation from its History, with `input` as the new message. */
  resume(threadId: string, input: NonNullable<ThreadSpec["input"]>): ThreadHandle;
  /** `thread_message` (see the header). */
  message(from: string, to: string, text: string, wait: boolean): Promise<ThreadMessageResult>;
  /** Stops a running thread as cancelled. */
  abort(threadId: string): void;
  /** Stops every running thread. */
  abortAll(): void;
  /**
   * Sets who admits and watches a wake from `thread_message`. `wake` throws to refuse, or
   * calls `start` and returns its handle. Without one, a wake just starts the thread.
   */
  onWake(wake: (spec: ThreadSpec, start: () => ThreadHandle) => ThreadHandle): void;
}

interface Entry {
  spec: ThreadSpec;
  abort: AbortController;
  handle: ThreadHandle;
  running: boolean;
}

export function threads(shared: Shared, signal?: AbortSignal): Threads {
  const entries = new Map<string, Entry>();
  let wake: Parameters<Threads["onWake"]>[0] = (_, start) => start();

  function launch(spec: ThreadSpec): Entry {
    const abort = new AbortController();
    const stop = () => abort.abort();
    signal?.addEventListener("abort", stop);
    if (signal?.aborted) stop();
    const handle = startThread({ ...shared, ...spec, signal: abort.signal });
    const entry: Entry = { spec, abort, handle, running: true };
    entries.set(spec.threadId, entry);
    // `entry.running` is read right after the thread's steering window closes, so it
    // clears in the same tick `done` resolves.
    void handle.done
      .finally(() => {
        entry.running = false;
        signal?.removeEventListener("abort", stop);
      })
      .catch(() => {});
    return entry;
  }

  return {
    start(spec) {
      if (entries.get(spec.threadId)?.running) {
        throw new Error(`thread ${spec.threadId} is already running`);
      }
      return launch(spec).handle;
    },
    resume(threadId, input) {
      const entry = entries.get(threadId);
      if (!entry) throw new Error(`no thread ${threadId} in this run`);
      if (entry.running) throw new Error(`thread ${threadId} is already running`);
      return launch({ ...entry.spec, input }).handle;
    },
    abort: (threadId) => entries.get(threadId)?.abort.abort(),
    abortAll: () => {
      for (const entry of entries.values()) entry.abort.abort();
    },
    onWake: (fn) => {
      wake = fn;
    },
    async message(from, to, text, wait) {
      const target = entries.get(to);
      if (!target) throw new Error(`no thread ${to} in this run`);
      if (to === from) throw new Error("a thread cannot message itself");
      if (wait && target.spec.parentThreadId !== from) {
        throw new Error(`wait is allowed only toward threads you started; ${to} is not yours`);
      }
      const sender = { kind: "thread", threadId: from } as const;
      let delivery: ThreadMessageResult["delivery"] = "steered";
      let handle = target.handle;
      if (!(target.running && handle.send(text, sender))) {
        delivery = "queued";
        // `send` refuses once the thread has ended, a moment before `running` clears.
        await handle.done.catch(() => {});
        const input = { text, sender };
        handle = wake({ ...target.spec, input }, () => this.resume(to, input));
      }
      if (!wait) return { delivery };
      const outcome: ThreadOutcome = await handle.done;
      return { delivery, reply: outcome.reply };
    },
  };
}
