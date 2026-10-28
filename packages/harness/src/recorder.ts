/**
 * A run's stream record writer. `emit` queues an event and returns at once; one queue
 * delivers events in order, so `seq` follows emission order, and nothing in the agent
 * loop waits for the API. A failed delivery never ends a thread: the event is retried
 * in the background, and this is the only place events are retried (the client makes one
 * attempt). The recorder also keeps every event it emitted, in emission order, as the
 * runtime's view of the run (`events()`; `fold` reads it, `task-tools.ts`): `seq` there is
 * the position, not the store's. An event emitted with an id the recorder already holds is
 * a no-op, so a resumed run (given the stored events) never writes a derived event twice.
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
  /**
   * `id` defaults to a random one; the task tools pass derived ids. Resolves true once the
   * event is stored (or was already held), false if it was invalid or delivery gave up.
   */
  emit<T extends EventType>(
    threadId: string,
    type: T,
    payload: PayloadOf<T>,
    id?: string,
  ): Promise<boolean>;
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

  async function deliver(event: EventInput): Promise<boolean> {
    for (let attempt = 1; ; attempt++) {
      try {
        await eventLog.append(event);
        return true;
      } catch (error) {
        if (attempt >= ATTEMPTS) {
          // The id is stable, so a later duplicate would be a no-op; this one is lost.
          console.error(`recorder: gave up on ${event.type} ${event.id}: ${String(error)}`);
          return false;
        }
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs * attempt));
      }
    }
  }

  return {
    events: () => held,
    emit(threadId, type, payload, id = crypto.randomUUID()) {
      if (ids.has(id)) return Promise.resolve(true);
      // Parsing types the envelope without a cast and checks the payload against the contract.
      const parsed = eventInputSchema.safeParse({
        id,
        runId,
        threadId,
        createdAt: new Date().toISOString(),
        type,
        payload,
      });
      if (!parsed.success) {
        console.error(`recorder: dropped invalid ${type} event: ${parsed.error.message}`);
        return Promise.resolve(false);
      }
      ids.add(id);
      held.push({ ...parsed.data, seq: held.length + 1 });
      const delivered = queue.then(() => deliver(parsed.data));
      queue = delivered;
      return delivered;
    },
    flush: async () => {
      await queue;
    },
  };
}
