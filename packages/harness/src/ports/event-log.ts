/**
 * The EventLog port: the stream record of a run (what people watch and review).
 * Appending an event whose `id` is already stored is a no-op, so a retry is safe;
 * the store assigns `seq`. An `id` already stored under a different run is a client bug:
 * `EventIdConflict`. Adapters: apps/api's Postgres adapter (the store) and
 * adapters/http (the client the runner uses).
 */
import type { EventInput } from "@voluma/contracts/events";

/** The event id is already stored under another run. */
export class EventIdConflict extends Error {}

export interface EventLog {
  append(event: EventInput): Promise<void>;
}
