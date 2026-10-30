/**
 * Which of a run's threads are open and which are running, from its events and state. A thread
 * is open when its latest `thread.started` has no `thread.ended` after it; a runtime abort
 * (shutdown, self-stop, lost lease) leaves threads open, and the next claim resumes them. A
 * thread is running only while its run is: once the run has ended (or waits for a runner or
 * keys), or its root thread has ended, no thread runs, whatever the log leaves open. Every
 * page asks here instead of guessing from a thread's last event.
 */
import type { EventInput, RunEvent } from "./events";
import type { RunState } from "./run";

/** Ids of the threads left open, in the order they first started; the root thread (kind `supervisor`) among them. */
export function openThreads(events: readonly RunEvent[]): string[] {
  const open = new Map<string, boolean>();
  for (const e of events) {
    if (e.type === "thread.started") open.set(e.threadId, true);
    else if (e.type === "thread.ended" && open.has(e.threadId)) open.set(e.threadId, false);
  }
  return [...open].flatMap(([id, isOpen]) => (isOpen ? [id] : []));
}

/**
 * A user's cancel is a deliberate stop, so it ends every open thread `cancelled` and the root
 * last, ids `<runId>:cancel:end:<threadId>`. The server writes them in the transaction that
 * ends the run: after that it refuses the runner's writes. A runtime abort writes none.
 */
export function cancelEnds(runId: string, events: readonly RunEvent[], at: Date): EventInput[] {
  const root = events.find((e) => e.type === "thread.started" && e.payload.kind === "supervisor");
  const isRoot = (id: string) => id === root?.threadId;
  return openThreads(events)
    .sort((a, b) => Number(isRoot(a)) - Number(isRoot(b)))
    .map((threadId) => ({
      id: `${runId}:cancel:end:${threadId}`,
      runId,
      threadId,
      type: "thread.ended",
      payload: { status: "cancelled" },
      createdAt: at.toISOString(),
    }));
}
