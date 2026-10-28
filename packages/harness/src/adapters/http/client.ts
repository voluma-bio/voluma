/**
 * The HTTP client for the EventLog and History ports: the run domain's ingest routes
 * with the bearer token. Event appends make one attempt: the recorder owns their retry
 * policy. History is the durable record and a failed write ends the thread, so its
 * calls ride out an outage of about HISTORY_BUDGET_MS; they are idempotent on the server
 * (an idx repeated with the same content is a no-op), so network and 5xx failures retry.
 * A 409 on a history append is the port's `HistoryConflict`, unless its body says the lease
 * is gone: on any call that is `LeaseLost`, never retried. `leaseToken` is the claim's, sent
 * on every call: there is no tokenless write (`@voluma/contracts/runner`). `storedEvents` is the
 * resume read, paged (`@voluma/contracts/events`).
 */
import { type EventInput, type RunEvent, runEventsResponseSchema } from "@voluma/contracts/events";
import { type HistoryRow, historyResponseSchema } from "@voluma/contracts/history";
import type { EventLog } from "../../ports/event-log";
import { type History, HistoryConflict } from "../../ports/history";
import { type Endpoint, HttpError, postJson, send } from "./request";

const HISTORY_BUDGET_MS = 60_000;

export function httpClient(
  config: Endpoint & {
    /** The run this client writes for: the history routes are under it. */
    runId: string;
    leaseToken: string;
  },
): EventLog & History & { storedEvents(): Promise<RunEvent[]> } {
  const { leaseToken } = config;
  const runPath = `/api/run/ingest/runs/${encodeURIComponent(config.runId)}`;
  const historyPath = (threadId: string) =>
    `${runPath}/threads/${encodeURIComponent(threadId)}/messages`;

  return {
    async append(event: EventInput) {
      await postJson(config, `${runPath}/events`, event, { leaseToken });
    },
    /** Every stored event of the run, oldest first: what a resumed run starts its recorder with. */
    async storedEvents() {
      const events: RunEvent[] = [];
      for (let more = true; more; ) {
        const after = events.at(-1)?.seq ?? 0;
        const response = await send(
          config,
          `${runPath}/events?after=${after}`,
          { leaseToken },
          HISTORY_BUDGET_MS,
        );
        const page = runEventsResponseSchema.parse(await response.json());
        events.push(...page.events);
        more = page.more;
      }
      return events;
    },
    async load(threadId) {
      const response = await send(config, historyPath(threadId), { leaseToken }, HISTORY_BUDGET_MS);
      return historyResponseSchema.parse(await response.json()).messages;
    },
    async appendMessage(threadId, idx, message) {
      try {
        await postJson(config, historyPath(threadId), { idx, message } satisfies HistoryRow, {
          leaseToken,
          retryForMs: HISTORY_BUDGET_MS,
        });
      } catch (error) {
        if (error instanceof HttpError && error.status === 409) {
          throw new HistoryConflict(error.message);
        }
        throw error;
      }
    },
  };
}
