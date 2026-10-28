/**
 * The EventLog port: the stream record of a run (what people watch and review).
 * Appending an event whose `id` is already stored is a no-op, so a retry is safe;
 * the store assigns `seq`. Adapter: adapters/http (the client the runner uses). The API stores events
 * through its own lease-checked log (apps/api's run domain), not this port.
 */
import type { EventInput } from "@voluma/contracts/events";

export interface EventLog {
  append(event: EventInput): Promise<void>;
}
