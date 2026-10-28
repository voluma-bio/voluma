/**
 * The runner's one client for a claimed run: the run domain's ingest routes under
 * `/api/run/ingest/runs/:id`, with the bearer token and the claim's lease token on every call
 * (there is no tokenless write: `@voluma/contracts/runner`). It is the EventLog and History
 * ports, the resume read, heartbeat and report, and it owns the two policies every call
 * shares:
 * - `onLeaseLost` runs once per failing call, as soon as any call finds the lease gone, before
 *   the error goes on (a 409 whose body is `leaseLostSchema`; never retried);
 * - `redact` is applied to every body before it is sent: to a history message first (it is
 *   JSON text inside the JSON body, so escaped twice), then to the serialized body.
 *
 * Event appends make one attempt: the recorder owns their retry policy. History is the
 * durable record and a failed write ends the thread, so its calls ride out an outage of about
 * HISTORY_BUDGET_MS; they are idempotent on the server (an idx repeated with the same
 * content is a no-op), so network and 5xx failures retry. A 409 on a history append is the
 * port's `HistoryConflict`. `storedEvents` is the resume read, paged (`@voluma/contracts/events`).
 * `live` posts a batch of live frames (`live.ts`): one attempt, and the caller drops a failure.
 * `heartbeat` makes one attempt: the caller keeps the usage and resends it if this throws.
 * `report` ends or releases the run; a 409 means the server ended the run first or the lease
 * is no longer ours, so it returns. A network failure is retried for REPORT_BUDGET_MS; the
 * lease expires on its own after that.
 */
import { type EventInput, type RunEvent, runEventsResponseSchema } from "@voluma/contracts/events";
import { type HistoryRow, historyResponseSchema } from "@voluma/contracts/history";
import {
  type HeartbeatResponse,
  heartbeatResponseSchema,
  type ReportRequest,
  type Usage,
} from "@voluma/contracts/runner";
import type { LiveFrame } from "@voluma/contracts/stream";
import type { EventLog } from "../../ports/event-log";
import { type History, HistoryConflict } from "../../ports/history";
import { LeaseLost } from "../../ports/lease-lost";
import { type Endpoint, HttpError, postJson, send } from "./request";

const HISTORY_BUDGET_MS = 60_000;
const REPORT_BUDGET_MS = 60_000;

export interface RunClient extends EventLog, History {
  storedEvents(): Promise<RunEvent[]>;
  heartbeat(usage: Usage): Promise<HeartbeatResponse>;
  report(report: ReportRequest["report"]): Promise<void>;
  /** One batch of live frames: a single attempt, no retry (they are best effort). */
  live(frames: LiveFrame[]): Promise<void>;
}

export function runClient(
  endpoint: Endpoint,
  claim: { runId: string; leaseToken: string },
  policy: { redact(text: string): string; onLeaseLost(): void },
): RunClient {
  const { leaseToken } = claim;
  const { redact } = policy;
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
  const post = (path: string, body: unknown, retryForMs?: number) =>
    guarded(() => postJson(endpoint, path, body, { leaseToken, retryForMs, redact }));
  const get = (path: string) =>
    guarded(() => send(endpoint, path, { leaseToken }, HISTORY_BUDGET_MS));

  return {
    async append(event: EventInput) {
      await post(`${runPath}/events`, event);
    },
    /** Every stored event of the run, oldest first: what a resumed run starts its recorder with. */
    async storedEvents() {
      const events: RunEvent[] = [];
      for (let more = true; more; ) {
        const after = events.at(-1)?.seq ?? 0;
        const response = await get(`${runPath}/events?after=${after}`);
        const page = runEventsResponseSchema.parse(await response.json());
        events.push(...page.events);
        more = page.more;
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
        await post(historyPath(threadId), row, HISTORY_BUDGET_MS);
      } catch (error) {
        if (error instanceof HttpError && error.status === 409) {
          throw new HistoryConflict(error.message);
        }
        throw error;
      }
    },
    async live(frames) {
      await post(`${runPath}/live`, { frames });
    },
    async heartbeat(usage) {
      const response = await post(`${runPath}/heartbeat`, { usage });
      return heartbeatResponseSchema.parse(await response.json());
    },
    async report(report) {
      try {
        await post(`${runPath}/report`, { report }, REPORT_BUDGET_MS);
      } catch (error) {
        if (error instanceof LeaseLost || (error instanceof HttpError && error.status === 409)) {
          return;
        }
        throw error;
      }
    },
  };
}
