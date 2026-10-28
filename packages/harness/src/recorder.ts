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
 * API, and a failed delivery is retried in the background (the only place events are
 * retried; the client makes one attempt). A retrying `emit` holds back every later event,
 * because nothing should be decided past a gap in the record. `append` is the runtime's: it
 * waits its turn in the queue, makes one attempt and resolves once the store has
 * acknowledged the event, so it never sleeps inside the runtime's critical section; it throws
 * if the event is invalid or the store refuses it, and the id can be written again.
 * Live output is not an event (see `@voluma/contracts/stream`) and does not
 * pass through here. The creator of the recorder `flush()`es when its threads end so the
 * record is complete before the process exits.
 *
 * A `LeaseLost` is not retried: the run is no longer this runner's, so the recorder calls
 * `onLeaseLost` once (the creator aborts the run) and drops every event still queued.
 *
 * A durable event that exhausts its retries is lost and leaves the projection stale (a
 * finished thread shown as running). Giving up should become a visible run failure.
 */
import {
  type EventInput,
  type EventType,
  eventInputSchema,
  type RunEvent,
} from "@voluma/contracts/events";
import type { EventLog } from "./ports/event-log";
import { LeaseLost } from "./ports/lease-lost";

export type PayloadOf<T extends EventType> = Extract<EventInput, { type: T }>["payload"];

export interface Recorder {
  /** Queues the event for background delivery with retries; `id` defaults to a random one. */
  emit<T extends EventType>(threadId: string, type: T, payload: PayloadOf<T>, id?: string): void;
  /**
   * Stores the event after everything queued before it, with one attempt, and adds it to the
   * view once stored; an id already held or queued is a no-op. Throws if the event is invalid
   * or the store refuses it, leaving the view as it was.
   */
  append<T extends EventType>(
    threadId: string,
    type: T,
    payload: PayloadOf<T>,
    id: string,
  ): Promise<void>;
  /** The stored events: those the recorder started with and those it has since delivered. */
  events(): readonly RunEvent[];
  /** Resolves once every event queued so far is stored or given up on. */
  flush(): Promise<void>;
}

const ATTEMPTS = 5;
const RETRY_DELAY_MS = 2_000;

/** `stored` is the run's already stored events, for a resume. */
export function recorder(
  eventLog: EventLog,
  runId: string,
  onLeaseLost: () => void,
  retryDelayMs = RETRY_DELAY_MS,
  stored: readonly RunEvent[] = [],
): Recorder {
  let queue: Promise<unknown> = Promise.resolve();
  let leaseLost = false;
  const held: RunEvent[] = [...stored];
  const ids = new Set(held.map((e) => e.id)); // held, and queued for delivery

  function loseLease() {
    if (leaseLost) return;
    leaseLost = true;
    onLeaseLost();
  }

  /** Stores the event (up to `attempts` tries) and adds it to the view, or throws. */
  async function deliver(event: EventInput, attempts: number): Promise<void> {
    try {
      for (let attempt = 1; ; attempt++) {
        if (leaseLost) throw new LeaseLost("the run's lease is lost");
        try {
          await eventLog.append(event);
          held.push({ ...event, seq: held.length + 1 });
          return;
        } catch (error) {
          if (error instanceof LeaseLost) loseLease();
          if (error instanceof LeaseLost || attempt >= attempts) throw error;
          await new Promise((resolve) => setTimeout(resolve, retryDelayMs * attempt));
        }
      }
    } catch (error) {
      ids.delete(event.id); // the id can be written again
      throw error;
    }
  }

  const enqueue = (event: EventInput, attempts: number): Promise<void> => {
    ids.add(event.id);
    const result = queue.then(() => deliver(event, attempts));
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
    emit(threadId, type, payload, id = crypto.randomUUID()) {
      if (ids.has(id)) return;
      const parsed = parse(threadId, type, payload, id);
      if (!parsed.success) {
        console.error(`recorder: dropped invalid ${type} event: ${parsed.error.message}`);
        return;
      }
      enqueue(parsed.data, ATTEMPTS).catch((error) => {
        if (!(error instanceof LeaseLost)) {
          console.error(`recorder: gave up on ${type} ${id}: ${String(error)}`);
        }
      });
    },
    async append(threadId, type, payload, id) {
      if (ids.has(id)) return queue.then(() => {}); // wait for it if it is still queued
      const parsed = parse(threadId, type, payload, id);
      if (!parsed.success) {
        throw new Error(`the ${type} event ${id} is invalid: ${parsed.error.message}`);
      }
      await enqueue(parsed.data, 1);
    },
    flush: async () => {
      await queue;
    },
  };
}
