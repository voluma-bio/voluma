/**
 * A run's stream record writer. `emit` queues an event and returns at once; one queue
 * delivers events in order, so `seq` follows emission order, and nothing in the agent
 * loop waits for the API. A failed delivery never ends a thread: the event is retried
 * in the background, and this is the only place events are retried (the client makes one
 * attempt). The recorder also keeps every event it emitted, in emission order, as the
 * runtime's view of the run (`events()`; `fold` reads it, `task-tools.ts`): `seq` there is
 * the position, not the store's. An event with an id the recorder already holds is a no-op,
 * so a resumed run (given the stored events) never writes a derived event twice.
 *
 * Two write paths. `emit` is the stream record's: the event joins the view at once and is
 * delivered in the background with retries. `append` is the runtime's: it makes one attempt
 * outside the queue and joins the view only once the store has acknowledged it, so the
 * runtime never decides from an event the store lacks, and a failed id can be written again.
 * Live output is not an event (see `@voluma/contracts/stream`) and does not
 * pass through here. The creator of the recorder `flush()`es when its threads end so the
 * record is complete before the process exits.
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

export type PayloadOf<T extends EventType> = Extract<EventInput, { type: T }>["payload"];

export interface Recorder {
  /** Queues the event for background delivery; `id` defaults to a random one. */
  emit<T extends EventType>(threadId: string, type: T, payload: PayloadOf<T>, id?: string): void;
  /**
   * Stores the event with one attempt and adds it to the view once stored; an id already
   * held is a no-op. Throws if the event is invalid or the store refuses it, leaving the
   * view as it was.
   */
  append<T extends EventType>(
    threadId: string,
    type: T,
    payload: PayloadOf<T>,
    id: string,
  ): Promise<void>;
  /** Every event emitted so far (and the stored ones the recorder started with). */
  events(): readonly RunEvent[];
  /** Resolves once every event emitted so far is stored or given up on. */
  flush(): Promise<void>;
}

const ATTEMPTS = 5;
const RETRY_DELAY_MS = 2_000;

/** `stored` is the run's already stored events, for a resume. */
export function recorder(
  eventLog: EventLog,
  runId: string,
  retryDelayMs = RETRY_DELAY_MS,
  stored: readonly RunEvent[] = [],
): Recorder {
  let queue: Promise<unknown> = Promise.resolve();
  const held: RunEvent[] = [...stored];
  const ids = new Set(held.map((e) => e.id));

  async function deliver(event: EventInput): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        await eventLog.append(event);
        return;
      } catch (error) {
        if (attempt >= ATTEMPTS) {
          // The id is stable, so a later duplicate would be a no-op; this one is lost.
          console.error(`recorder: gave up on ${event.type} ${event.id}: ${String(error)}`);
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs * attempt));
      }
    }
  }

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

  const hold = (event: EventInput) => {
    if (ids.has(event.id)) return;
    ids.add(event.id);
    held.push({ ...event, seq: held.length + 1 });
  };

  return {
    events: () => held,
    emit(threadId, type, payload, id = crypto.randomUUID()) {
      if (ids.has(id)) return;
      const parsed = parse(threadId, type, payload, id);
      if (!parsed.success) {
        console.error(`recorder: dropped invalid ${type} event: ${parsed.error.message}`);
        return;
      }
      hold(parsed.data);
      queue = queue.then(() => deliver(parsed.data));
    },
    async append(threadId, type, payload, id) {
      if (ids.has(id)) return;
      const parsed = parse(threadId, type, payload, id);
      if (!parsed.success) {
        throw new Error(`the ${type} event ${id} is invalid: ${parsed.error.message}`);
      }
      await eventLog.append(parsed.data);
      hold(parsed.data);
    },
    flush: async () => {
      await queue;
    },
  };
}
