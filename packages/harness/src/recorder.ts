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
 * waits its turn in the queue and resolves once the store has acknowledged the event; it
 * throws if the event is invalid or the store refuses it, and the id can be written again.
 * Both retry under one policy, and only an unavailable store (`EventLogUnavailable`) is
 * retried: a refusal fails at once. A retry after a lost response is safe because the store
 * ignores an event id it already holds.
 * Live frames are not events (see `@voluma/contracts/stream`): `live` hands them to a batcher
 * (`live.ts`) that never waits, and they do not join the queue, the view or `flush`. The creator of the recorder `flush()`es when its threads end so the
 * record is complete before the process exits.
 *
 * A `LeaseLost` is not retried: the run is no longer this runner's, so the recorder calls
 * `onStop("lease-lost")` once (the creator aborts the run) and drops every event still queued.
 * An event is retried until SELF_STOP_SECONDS have passed since its first failure, the same
 * window the heartbeat's self-stop gives an outage, so an API that refuses only event writes
 * cannot hold the queue for ever. A store still unavailable then is the same stop with reason
 * "unreachable": the run is not at fault, so the creator releases it for another claim to
 * resume, and `failure()` stays empty. The retries also end at the first failed attempt once
 * `runStopped` aborts (the run is being released anyway); events queued before the abort are
 * still delivered while the store answers. The first failure of an event is logged, then one
 * line every 30 s.
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
import { SELF_STOP_SECONDS } from "@voluma/contracts/runner";
import type { LiveFrame } from "@voluma/contracts/stream";
import type { LiveBatcher, LiveBody } from "./live";
import { type EventLog, EventLogUnavailable } from "./ports/event-log";
import { LeaseLost } from "./ports/lease-lost";

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
  /** The stored events: those the recorder started with and those it has since delivered. */
  events(): readonly RunEvent[];
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

const RETRY_DELAY_MS = 2_000;
const GIVE_UP_AFTER_MS = SELF_STOP_SECONDS * 1000;
const LOG_EVERY_MS = 30_000;

/** `stored` is the run's already stored events, for a resume. */
export function recorder(
  eventLog: EventLog,
  runId: string,
  onStop: (reason: "lease-lost" | "unreachable") => void,
  retryDelayMs = RETRY_DELAY_MS,
  stored: readonly RunEvent[] = [],
  live?: LiveBatcher,
  runStopped?: AbortSignal,
  giveUpAfterMs = GIVE_UP_AFTER_MS,
): Recorder {
  let queue: Promise<unknown> = Promise.resolve();
  let stopped = false; // the creator has been told to stop: nothing more is delivered
  const held: RunEvent[] = [...stored];
  const ids = new Set(held.map((e) => e.id)); // held, and queued for delivery
  const storedIds = new Set(ids);
  let failure: unknown;

  function stop(reason: "lease-lost" | "unreachable") {
    if (stopped) return;
    stopped = true;
    onStop(reason);
  }

  /** Stores the event (retried for `giveUpAfterMs` from its first failure) and adds it to the view, or throws. */
  async function deliver(event: EventInput): Promise<void> {
    let firstFailure = 0;
    let loggedAt = 0;
    try {
      for (let attempt = 1; ; attempt++) {
        if (stopped) throw new RecorderStopped();
        try {
          await eventLog.append(event);
          held.push({ ...event, seq: held.length + 1 });
          storedIds.add(event.id);
          return;
        } catch (error) {
          if (error instanceof LeaseLost) stop("lease-lost");
          if (!(error instanceof EventLogUnavailable)) throw error;
          const now = Date.now();
          firstFailure ||= now;
          if (now - firstFailure >= giveUpAfterMs || runStopped?.aborted) {
            stop("unreachable");
            throw error;
          }
          if (now - loggedAt >= LOG_EVERY_MS) {
            loggedAt = now;
            console.error(
              `recorder: ${event.type} ${event.id} not stored for ${Math.round((now - firstFailure) / 1000)} s, retrying: ${error.message}`,
            );
          }
          await new Promise((resolve) => setTimeout(resolve, retryDelayMs * attempt));
        }
      }
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
    flush: async () => {
      await queue;
    },
    failure: () => failure,
  };
}
