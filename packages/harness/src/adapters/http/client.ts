/**
 * The HTTP client for the EventLog and History ports: the run domain's ingest routes
 * with the bearer token. Event appends make one attempt: the recorder owns their retry
 * policy. History is the durable record and a failed write ends the thread, so its
 * calls ride out an outage of about HISTORY_BUDGET_MS; they are idempotent on the server
 * (an idx repeated with the same content is a no-op), so network and 5xx failures retry.
 * A 409 on a history append is the port's `HistoryConflict`.
 */
import type { EventInput } from "@voluma/contracts/events";
import { type HistoryRow, historyResponseSchema } from "@voluma/contracts/history";
import type { EventLog } from "../../ports/event-log";
import { type History, HistoryConflict } from "../../ports/history";

const HISTORY_BUDGET_MS = 60_000;
const MAX_BACKOFF_MS = 5_000;
const ATTEMPT_TIMEOUT_MS = 15_000;

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function httpClient(config: { baseUrl: string; token: string }): EventLog & History {
  const url = (path: string) => new URL(path, config.baseUrl);

  /** `retryForMs`: keep retrying network and 5xx failures until this long has passed. */
  async function send(path: string, init: RequestInit, retryForMs = 0): Promise<Response> {
    const deadline = Date.now() + retryForMs;
    for (let attempt = 1; ; attempt++) {
      try {
        const response = await fetch(url(path), {
          ...init,
          headers: { ...init.headers, authorization: `Bearer ${config.token}` },
          signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
        });
        if (response.ok) return response;
        throw new HttpError(
          response.status,
          `${path}: ${response.status} ${await response.text()}`,
        );
      } catch (error) {
        if ((error instanceof HttpError && error.status < 500) || Date.now() >= deadline) {
          throw error;
        }
      }
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(200 * 2 ** attempt, MAX_BACKOFF_MS)),
      );
    }
  }

  const post = (path: string, body: unknown, retryForMs?: number) =>
    send(
      path,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
      retryForMs,
    );

  return {
    async append(event: EventInput) {
      await post(`/run/ingest/runs/${encodeURIComponent(event.runId)}/events`, event);
    },
    async load(threadId) {
      const response = await send(
        `/run/ingest/threads/${encodeURIComponent(threadId)}/messages`,
        {},
        HISTORY_BUDGET_MS,
      );
      return historyResponseSchema.parse(await response.json()).messages;
    },
    async appendMessage(threadId, idx, message) {
      try {
        await post(
          `/run/ingest/threads/${encodeURIComponent(threadId)}/messages`,
          { idx, message } satisfies HistoryRow,
          HISTORY_BUDGET_MS,
        );
      } catch (error) {
        if (error instanceof HttpError && error.status === 409) {
          throw new HistoryConflict(error.message);
        }
        throw error;
      }
    },
  };
}
