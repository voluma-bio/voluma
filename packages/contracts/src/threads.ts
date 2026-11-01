/**
 * Which of a run's threads are open and which are running, from its events and state. A thread
 * is open when its latest `thread.started` has no `thread.ended` after it; a runtime abort
 * (shutdown, self-stop, lost lease) leaves threads open, and the next claim resumes them. A
 * thread is running only while its run is: once the run has ended (or waits for a runner or
 * keys), or its root thread has ended, no thread runs, whatever the log leaves open. Every
 * page asks here instead of guessing from a thread's last event.
 */
import type { EventInput, RunEvent } from "./events";
import { threadPlace } from "./thread-place";

/** Ids of the threads left open, in the order they first started; the root thread (kind `supervisor`) among them. */
export function openThreads(events: readonly RunEvent[]): string[] {
  const open = new Map<string, boolean>();
  for (const e of events) {
    if (e.type === "thread.started") open.set(e.threadId, true);
    else if (e.type === "thread.ended" && open.has(e.threadId)) open.set(e.threadId, false);
  }
  return [...open].flatMap(([id, isOpen]) => (isOpen ? [id] : []));
}

/** Ids of the threads whose latest `thread.ended` is `failed`. */
export function failedThreads(events: readonly RunEvent[]): Set<string> {
  const failed = new Set<string>();
  for (const e of events)
    if (e.type === "thread.ended") {
      if (e.payload.status === "failed") failed.add(e.threadId);
      else failed.delete(e.threadId);
    } else if (e.type === "thread.started") failed.delete(e.threadId);
  return failed;
}

/**
 * The server's cancel of a run that did not finish (a user's cancel, or a failure it records as
 * one): every open thread ends `cancelled` and the root last. The server writes the ends in the
 * transaction that ends the run: after that it refuses the runner's writes. A runtime abort
 * writes none. Ids are `<the thread's latest thread.started id>:cancel:end`: a thread, the root
 * above all, has one id for every claim, so an id keyed to the thread would collide with the
 * end of an earlier correction.
 *
 * In a correction (`openSince`) the ends also cover the threads that already finished inside
 * it, root excepted: the correction is discarded, and an agent that resumed would believe its
 * reverted work stands. The next correction starts them fresh (`messages.ts`).
 */
export function cancelEnds(
  runId: string,
  events: readonly RunEvent[],
  at: Date,
  /** The `seq` of the open correction's `run.reopened` (`corrections`), if one is open. */
  openSince: number | undefined,
): EventInput[] {
  const root = events.find((e) => e.type === "thread.started" && threadPlace(e.payload) === "root");
  const isRoot = (id: string) => id === root?.threadId;
  const start = new Map<string, string>(); // thread -> its latest thread.started id
  const stopped = new Set<string>(); // threads whose latest end is `cancelled`
  for (const e of events) {
    if (e.type === "thread.started") {
      start.set(e.threadId, e.id);
      stopped.delete(e.threadId);
    } else if (e.type === "thread.ended" && e.payload.status === "cancelled") {
      stopped.add(e.threadId);
    }
  }
  const ending = new Set(openThreads(events));
  if (openSince !== undefined) {
    for (const e of events.filter((e) => e.seq >= openSince)) {
      if (start.has(e.threadId) && !isRoot(e.threadId) && !stopped.has(e.threadId))
        ending.add(e.threadId);
    }
  }
  return [...ending]
    .sort((a, b) => Number(isRoot(a)) - Number(isRoot(b)))
    .map((threadId) => ({
      id: `${start.get(threadId)}:cancel:end`,
      runId,
      threadId,
      type: "thread.ended",
      payload: { status: "cancelled" },
      createdAt: at.toISOString(),
    }));
}
