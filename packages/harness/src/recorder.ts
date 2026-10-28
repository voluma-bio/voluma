/**
 * A run's stream record writer. `emit` queues an event and returns at once; one queue
 * delivers events in order, so `seq` follows emission order, and nothing in the agent
 * loop waits for the API. A failed delivery never ends a thread: the event is retried
 * in the background, except `tool.output`, which is live-only and dropped. Callers
 * `flush()` when a thread ends so the record is complete before the process exits.
 */
import { type EventInput, type EventType, eventInputSchema } from "@voluma/contracts/events";
import type { EventLog } from "./ports/event-log";

export type PayloadOf<T extends EventType> = Extract<EventInput, { type: T }>["payload"];

export interface Recorder {
  emit<T extends EventType>(threadId: string, type: T, payload: PayloadOf<T>): void;
  /** Resolves once every event emitted so far is stored or given up on. */
  flush(): Promise<void>;
}

const ATTEMPTS = 5;
const RETRY_DELAY_MS = 2_000;

export function recorder(
  eventLog: EventLog,
  runId: string,
  retryDelayMs = RETRY_DELAY_MS,
): Recorder {
  let queue: Promise<void> = Promise.resolve();

  async function deliver(event: EventInput): Promise<void> {
    const attempts = event.type === "tool.output" ? 1 : ATTEMPTS;
    for (let attempt = 1; ; attempt++) {
      try {
        await eventLog.append(event);
        return;
      } catch (error) {
        if (attempt >= attempts) {
          // The id is stable, so a later duplicate would be a no-op; this one is lost.
          if (event.type !== "tool.output")
            console.error(`recorder: gave up on ${event.type} ${event.id}: ${String(error)}`);
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs * attempt));
      }
    }
  }

  return {
    emit(threadId, type, payload) {
      // Parsing types the envelope without a cast and checks the payload against the contract.
      const parsed = eventInputSchema.safeParse({
        id: crypto.randomUUID(),
        runId,
        threadId,
        createdAt: new Date().toISOString(),
        type,
        payload,
      });
      if (!parsed.success) {
        console.error(`recorder: dropped invalid ${type} event: ${parsed.error.message}`);
        return;
      }
      queue = queue.then(() => deliver(parsed.data));
    },
    flush: () => queue,
  };
}
