/**
 * The EventLog port: the stream record of a run (what people watch and review).
 * Appending an event whose `id` is already stored is a no-op, so a retry is safe;
 * the store assigns `seq`. Adapters: apps/api's D1 adapter (the store) and
 * adapters/http (the client the runner uses).
 */
import type { EventInput } from "@voluma/contracts/events";

export interface EventLog {
  append(event: EventInput): Promise<void>;
}
