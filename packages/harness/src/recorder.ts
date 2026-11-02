/**
 * A run's stream record writer, and the runtime's view of the run. One ordered queue
 * delivers every event, `emit` and `append` alike, so `seq` follows enqueue order. An event
 * joins the view (`events()`; `fold` reads it, `task-tools.ts`) only once the store has
 * acknowledged it, in delivery order, so the view is always a prefix of the store: a
 * recorder started with the stored events (a resume) holds exactly the view the run had.
 * An event with an id the recorder already holds or has queued is a no-op, so a resumed run
 * never writes a derived event twice.
 *
 * `emit` is the stream record's: it returns at once, nothing in the agent loop waits for the
 * API, and a slow or failing delivery goes on in the background (the event log retries it,
 * `run-client.ts`). A retrying `emit` holds back every later event,
 * because nothing should be decided past a gap in the record. `append` is the runtime's: it
 * waits its turn in the queue and resolves once the store has acknowledged the event; it
 * throws if the event is invalid or the store refuses it, and the id can be written again.
 * A retry after a lost response is safe because the store ignores an event id it already holds.
 * Live frames are not events (see `@voluma/contracts/stream`): `live` hands them to a batcher
 * (`live.ts`) that never waits, and they do not join the queue, the view or `flush`. The creator of the recorder `flush()`es when its threads end so the
 * record is complete before the process exits.
 *
 * The view is a gapless prefix of the store up to its last `seq`, in store order. The API
 * writes into a running claim too (marks, saved views, `tocheck.resolved`, and the messages
 * and answers of a later lane), and a delivery cursor is a position in the event list, so an
 * event may only ever join the view at its end, never before an event the view already holds.
 * Two things keep that true, both inside the same queue turn as the runner's own events so
 * nothing of the runner's lands between: `deliver` stores an event, and when the store says its
 * `seq` is above the view's next one, it first reads the events in between and adds them
 * ahead of its own; `pull` (the heartbeat saw a `lastSeq` past the view) reads everything after the
 * view; at most one pull is pending. The view advances by the last `seq` read, not by a count: the
 * event log skips an event it cannot parse, so a page can have holes. A store that returns no `seq` (an API from
 * before the pull) gets no gap fill, so the view then numbers the event after its last. A read
 * of the store that runs out of retries (`EventLogUnavailable`) stops the recorder like a failed
 * write: the run is released and the next claim resumes from the store.
 *
 * `endedSeq()` is the view's last `seq` when the root thread's end was delivered, before the events
 * stored below it were added: what the runner had read when it decided to end.
 *
 * A `LeaseLost` is not retried: the run is no longer this runner's, so the recorder calls
 * `onLeaseLost` once (the creator aborts the run) and drops every event still queued. The
 * event log retries an unavailable store itself, for a bounded time (`run-client.ts`), and
 * stops the run when that runs out; the recorder then drops what is still queued too, and
 * `failure()` stays empty: the run is not at fault, so it is released for another claim to resume.
 *
 * An event the store refuses, and an `emit` of an invalid event (our code broke the
 * contract), is lost: `failure()` holds the error, and the supervisor fails the run on it
 * rather than carry on from a record the store lacks.
 */
import {
  type EventInput,
  type EventType,
  eventInputSchema,
  type RunEvent,
} from "@voluma/contracts/events";
import type { LiveFrame } from "@voluma/contracts/stream";
import type { LiveBatcher, LiveBody } from "./live";
import { type EventLog, EventLogUnavailable } from "./ports/event-log";
import { LeaseLost } from "./ports/lease-lost";
import { ROOT_NAME, threadIdOf } from "./thread-id";

export type PayloadOf<T extends EventType> = Extract<EventInput, { type: T }>["payload"];

export interface Recorder {
  /** Queues the event for background delivery with retries; `id` defaults to a random one. */
  emit<T extends EventType>(threadId: string, type: T, payload: PayloadOf<T>, id?: string): void;
  /** Sends a live frame, best effort: it returns at once and may be dropped. */
  live(frame: LiveBody): void;
  /**
   * Stores the event after everything queued before it, with retries, and adds it to the
   * view once stored; an id already held or queued is a no-op. Throws if the event is invalid
   * or the store refuses it, leaving the view as it was.
   */
  append<T extends EventType>(
    threadId: string,
    type: T,
    payload: PayloadOf<T>,
    id: string,
  ): Promise<void>;
  /**
   * Adds the events the store holds past the view, after everything queued before this call, if
   * `lastSeq` (the store's last `seq`, from a heartbeat) is past the view. Throws if the store
   * cannot be read; the next call retries.
   */
  pull(lastSeq: number): Promise<void>;
  /** The view's last `seq` when the root thread's `thread.ended` was delivered; undefined until then. */
  endedSeq(): number | undefined;
  /** The stored events: those the recorder started with, those it has delivered and those it pulled. */
  events(): readonly RunEvent[];
  /** Calls `listener` with each event once it joins the view (not the events the recorder started with). */
  onStored(listener: (event: RunEvent) => void): void;
  /** Calls `listener` after events the runner did not write (pulled, or a gap filled) join the view. */
  onPulled(listener: () => void): void;
  /** Resolves once every event queued so far is stored or given up on. */
  flush(): Promise<void>;
  /** The first error that made `emit` give up on an event; undefined while none has. */
  failure(): unknown;
}

/** A delivery refused because the recorder already stopped; not a failure of its event. */
class RecorderStopped extends Error {
  constructor() {
    super("the run has stopped");
  }
}

/** `stored` is the run's already stored events, for a resume. */
export function recorder(
  eventLog: EventLog,
  runId: string,
  onLeaseLost: () => void,
  stored: readonly RunEvent[] = [],
  live?: LiveBatcher,
): Recorder {
  let queue: Promise<unknown> = Promise.resolve();
  let stopped = false; // the lease is lost or the log unreachable: nothing more is delivered
  const held: RunEvent[] = [...stored];
  const ids = new Set(held.map((e) => e.id)); // held, and queued for delivery
  const storedIds = new Set(ids);
  let failure: unknown;
  const listeners: ((event: RunEvent) => void)[] = [];
  const pulledListeners: (() => void)[] = [];
  const viewSeq = () => held.at(-1)?.seq ?? 0;
  const rootThreadId = threadIdOf(runId, ROOT_NAME);
  let endedSeq: number | undefined;
  let pulling: Promise<void> | undefined;

  /** The store's answer to a call failed: a lost lease or an unreachable store ends deliveries. */
  function storeFailed(error: unknown) {
    if (error instanceof LeaseLost && !stopped) onLeaseLost();
    if (error instanceof LeaseLost || error instanceof EventLogUnavailable) stopped = true;
  }

  /** Adds events the store holds that the runner did not write, in store order. */
  function join(read: readonly RunEvent[]) {
    for (const event of read) {
      if (storedIds.has(event.id)) continue;
      held.push(event);
      ids.add(event.id);
      storedIds.add(event.id);
      for (const listener of listeners) listener(event);
    }
    if (read.length > 0) for (const listener of pulledListeners) listener();
  }

  /** Stores the event (the log retries it) and adds it to the view, or throws. */
  async function deliver(event: EventInput): Promise<void> {
    try {
      if (stopped) throw new RecorderStopped();
      const before = viewSeq();
      let seq: number | undefined;
      try {
        seq = await eventLog.append(event);
        // Events the API wrote below `seq` come first, so the view has no hole before this event.
        // If this read fails the event is stored but not in the view: the claim stops and the next resumes.
        if (seq !== undefined && seq > viewSeq() + 1)
          join(await eventLog.eventsAfter(viewSeq(), seq - 1));
      } catch (error) {
        storeFailed(error);
        throw error;
      }
      if (event.type === "thread.ended" && event.threadId === rootThreadId) endedSeq ??= before;
      const stored = { ...event, seq: seq ?? viewSeq() + 1 };
      held.push(stored);
      storedIds.add(event.id);
      for (const listener of listeners) listener(stored);
    } catch (error) {
      ids.delete(event.id); // the id can be written again
      throw error;
    }
  }

  const enqueue = (event: EventInput): Promise<void> => {
    ids.add(event.id);
    const result = queue.then(() => deliver(event));
    queue = result.catch(() => {});
    return result;
  };

  /** Parsing types the envelope without a cast and checks the payload against the contract. */
  function parse<T extends EventType>(
    threadId: string,
    type: T,
    payload: PayloadOf<T>,
    id: string,
  ) {
    return eventInputSchema.safeParse({
      id,
      runId,
      threadId,
      createdAt: new Date().toISOString(),
      type,
      payload,
    });
  }

  return {
    events: () => held,
    endedSeq: () => endedSeq,
    pull(lastSeq) {
      if (pulling) return pulling;
      if (lastSeq <= viewSeq()) return Promise.resolve();
      const result = queue.then(async () => {
        if (stopped || lastSeq <= viewSeq()) return;
        try {
          join(await eventLog.eventsAfter(viewSeq()));
        } catch (error) {
          storeFailed(error);
          throw error;
        }
      });
      pulling = result.finally(() => {
        pulling = undefined;
      });
      queue = pulling.catch(() => {});
      return pulling;
    },
    live: (frame) => live?.push({ ...frame, runId } as LiveFrame),
    emit(threadId, type, payload, id = crypto.randomUUID()) {
      if (ids.has(id)) return;
      const parsed = parse(threadId, type, payload, id);
      if (!parsed.success) {
        // Our code broke the contract: fail the run (the supervisor reads `failure()`) rather
        // than store a record with a hole in it.
        const error = new Error(`the ${type} event ${id} is invalid: ${parsed.error.message}`);
        console.error(`recorder: ${error.message}`);
        failure ??= error;
        return;
      }
      enqueue(parsed.data).catch((error) => {
        if (
          !(
            error instanceof LeaseLost ||
            error instanceof EventLogUnavailable ||
            error instanceof RecorderStopped
          )
        ) {
          console.error(`recorder: gave up on ${type} ${id}: ${String(error)}`);
          failure ??= error;
        }
      });
    },
    async append(threadId, type, payload, id) {
      if (ids.has(id)) {
        await queue; // it may still be queued
        if (!storedIds.has(id))
          throw new Error(`the ${type} event ${id} was queued but not stored`);
        return;
      }
      const parsed = parse(threadId, type, payload, id);
      if (!parsed.success) {
        throw new Error(`the ${type} event ${id} is invalid: ${parsed.error.message}`);
      }
      await enqueue(parsed.data);
    },
    onStored: (listener) => {
      listeners.push(listener);
    },
    onPulled: (listener) => {
      pulledListeners.push(listener);
    },
    flush: async () => {
      await queue;
    },
    failure: () => failure,
  };
}
