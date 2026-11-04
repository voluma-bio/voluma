/**
 * The runner's one client for a claimed run: the run domain's ingest routes under
 * `/api/run/ingest/runs/:id`, with the bearer token and the claim's lease token on every call
 * (there is no tokenless write: `@voluma/contracts/runner`). It is the EventLog and History
 * ports, the resume read, heartbeat and report, and it owns the policies every call
 * shares:
 * - `onLeaseLost` runs once per failing call, as soon as any call finds the lease gone, before
 *   the error goes on (a 409 whose body is `leaseLostSchema`; never retried);
 * - `redact` is applied to every body before it is sent: to a history message first (it is
 *   JSON text inside the JSON body, so escaped twice), then to the serialized body.
 *
 * Event and history writes share one retry rule (`writes`): a network or 5xx failure is retried
 * until SELF_STOP_SECONDS after its first failure, or until the run stops (`policy.runStopped`).
 * If the time runs out, `policy.onUnreachable(firstFailureAt)` runs before the error goes on, so
 * the run is already stopping (released, not failed) when the caller sees it. A failed event
 * append is the port's `EventLogUnavailable`; a lease loss or a 4xx passes through. History
 * writes are idempotent on the server (an idx repeated with the same content is a no-op), and a
 * 409 on one is the port's `HistoryConflict`. `eventsAfter` is the read of the stored events (the
 * resume read from 0, the recorder's gap fill and tail pull), paged (`@voluma/contracts/events`): an event that
 * does not parse is skipped (the next page starts after its seq), and a read that runs out of retries calls
 * `policy.onUnreachable` and throws `EventLogUnavailable`, like a write. An append
 * answers with the stored seq; a 204 (an API from before that) answers none.
 * `heartbeat` makes one attempt, cut at HEARTBEAT_ATTEMPT_MS: the caller keeps the usage and resends it if this throws.
 * `report` ends or releases the run, with the last event seq it read; a 409 means the server ended the run first or the lease
 * is no longer ours, so it returns false (the caller logs that nothing was stored). A network failure is retried for REPORT_BUDGET_MS; the
 * lease expires on its own after that.
 */
import {
  appendEventResponseSchema,
  type EventInput,
  type RunEvent,
  runEventSchema,
} from "@voluma/contracts/events";
import { type HistoryRow, historyResponseSchema } from "@voluma/contracts/history";
import {
  type HeartbeatResponse,
  heartbeatResponseSchema,
  type ReportRequest,
  SELF_STOP_SECONDS,
  type Usage,
} from "@voluma/contracts/runner";
import { z } from "zod";
import { errorText } from "../../error-text";
import { type EventLog, EventLogUnavailable } from "../../ports/event-log";
import { type History, HistoryConflict } from "../../ports/history";
import { LeaseLost } from "../../ports/lease-lost";
import { type Endpoint, HttpError, postJson, send } from "./request";

const READ_BUDGET_MS = 60_000;
/** A page of stored events; each event is parsed on its own, so one the runner cannot read costs only itself. */
const pageSchema = z.object({
  events: z.array(z.looseObject({ seq: z.number().int() })),
  more: z.boolean(),
});
/** Short, so a heartbeat lost to a dead connection is retried in seconds (`lease.ts`). */
const HEARTBEAT_ATTEMPT_MS = 5_000;
const REPORT_BUDGET_MS = 60_000;

export interface RunClient extends EventLog, History {
  heartbeat(usage: Usage): Promise<HeartbeatResponse>;
  /** True when the server stored the report; false on a 409 (the run ended first, or the lease is gone). */
  report(report: ReportRequest["report"]): Promise<boolean>;
}

export function runClient(
  endpoint: Endpoint,
  claim: { runId: string; leaseToken: string },
  policy: {
    redact(text: string): string;
    onLeaseLost(): void;
    runStopped: AbortSignal;
    /** A write could not be stored for SELF_STOP_SECONDS; `firstFailureAt` is when it first failed. */
    onUnreachable(firstFailureAt: number): void;
  },
): RunClient {
  const { leaseToken } = claim;
  const { redact } = policy;
  const writes = {
    forMs: SELF_STOP_SECONDS * 1000,
    until: policy.runStopped,
    onGiveUp: policy.onUnreachable,
  };
  const runPath = `/api/run/ingest/runs/${encodeURIComponent(claim.runId)}`;
  const historyPath = (threadId: string) =>
    `${runPath}/threads/${encodeURIComponent(threadId)}/messages`;

  /** Every call goes through here: the lease-loss policy. */
  async function guarded<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      if (error instanceof LeaseLost) policy.onLeaseLost();
      throw error;
    }
  }
  const post = (path: string, body: unknown, retry?: Parameters<typeof send>[3]) =>
    guarded(() => postJson(endpoint, path, body, { leaseToken, retry, redact }));
  const get = (path: string, onGiveUp?: (firstFailureAt: number) => void) =>
    guarded(() => send(endpoint, path, { leaseToken }, { forMs: READ_BUDGET_MS, onGiveUp }));

  return {
    async append(event: EventInput) {
      try {
        const response = await post(`${runPath}/events`, event, writes);
        if (response.status === 204) return undefined;
        return appendEventResponseSchema.parse(await response.json()).seq;
      } catch (error) {
        const refused =
          error instanceof LeaseLost || (error instanceof HttpError && error.status < 500);
        if (refused) throw error;
        throw new EventLogUnavailable(errorText(error), { cause: error });
      }
    },
    async eventsAfter(after, upTo = Number.POSITIVE_INFINITY) {
      const events: RunEvent[] = [];
      // Each page starts after the last seq read, not after a count: a page can have holes.
      for (let cursor = after, more = true; more && cursor < upTo; ) {
        let page: z.infer<typeof pageSchema>;
        try {
          const response = await get(`${runPath}/events?after=${cursor}`, policy.onUnreachable);
          page = pageSchema.parse(await response.json());
        } catch (error) {
          if (error instanceof LeaseLost || (error instanceof HttpError && error.status < 500)) {
            throw error;
          }
          throw new EventLogUnavailable(errorText(error), { cause: error });
        }
        for (const raw of page.events) {
          if (raw.seq > upTo) continue;
          const event = runEventSchema.safeParse(raw);
          if (event.success) events.push(event.data);
          else console.error(`event ${raw.seq} skipped, it does not parse: ${event.error.message}`);
        }
        cursor = page.events.at(-1)?.seq ?? cursor;
        more = page.more && page.events.length > 0;
      }
      return events;
    },
    async load(threadId) {
      const response = await get(historyPath(threadId));
      return historyResponseSchema.parse(await response.json()).messages;
    },
    async appendMessage(threadId, idx, message) {
      try {
        const row = { idx, message: redact(message) } satisfies HistoryRow;
        await post(historyPath(threadId), row, writes);
      } catch (error) {
        if (error instanceof HttpError && error.status === 409) {
          throw new HistoryConflict(error.message);
        }
        throw error;
      }
    },
    async heartbeat(usage) {
      const response = await post(
        `${runPath}/heartbeat`,
        { usage },
        { attemptTimeoutMs: HEARTBEAT_ATTEMPT_MS },
      );
      return heartbeatResponseSchema.parse(await response.json());
    },
    async report(report) {
      try {
        await post(`${runPath}/report`, { report }, { forMs: REPORT_BUDGET_MS });
        return true;
      } catch (error) {
        if (error instanceof LeaseLost || (error instanceof HttpError && error.status === 409)) {
          return false;
        }
        throw error;
      }
    },
  };
}
