/**
 * The EventLog port: the stream record of a run (what people watch and review).
 * Appending an event whose `id` is already stored is a no-op, so a retry is safe;
 * the store assigns `seq`. Adapter: adapters/http (the client the runner uses). The API stores events
 * through its own lease-checked log (apps/api's run domain), not this port.
 */
import type { EventInput, RunEvent } from "@voluma/contracts/events";

/**
 * The store could not be reached or answered 5xx, and the adapter's own retries ran out: the event
 * may or may not be stored, and a retry is safe. Any other error is the store refusing the event, which a retry will not fix.
 */
export class EventLogUnavailable extends Error {}

export interface EventLog {
  /**
   * Returns the event's stored `seq` (for an id already stored, the seq it has), or nothing from
   * an API that does not say. Throws `LeaseLost`, `EventLogUnavailable`, or another error when the store refuses the event.
   */
  append(event: EventInput): Promise<number | undefined>;
  /** The stored events with `seq > after` (and `<= upTo`, if given), oldest first. */
  eventsAfter(after: number, upTo?: number): Promise<RunEvent[]>;
}
