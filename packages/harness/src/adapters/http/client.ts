/**
 * The HTTP client for the EventLog and History ports: the run domain's ingest routes
 * with the bearer token. Appends are idempotent on the server (an event id or a
 * history idx repeated with the same content is a no-op), so network and 5xx
 * failures retry. A 409 on a history append is the port's `HistoryConflict`.
 */
import type { EventInput } from "@voluma/contracts/events";
import type { EventLog } from "../../ports/event-log";
import { type History, HistoryConflict } from "../../ports/history";

const ATTEMPTS = 4;
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

  async function send(path: string, init: RequestInit): Promise<Response> {
    let lastError: unknown;
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 200 * 2 ** attempt));
      try {
        const response = await fetch(url(path), {
          ...init,
          headers: { ...init.headers, authorization: `Bearer ${config.token}` },
          signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
        });
        if (response.ok) return response;
        const error = new HttpError(
          response.status,
          `${path}: ${response.status} ${await response.text()}`,
        );
        if (response.status < 500) throw error;
        lastError = error;
      } catch (error) {
        if (error instanceof HttpError && error.status < 500) throw error;
        lastError = error;
      }
    }
    throw lastError;
  }

  const post = (path: string, body: unknown) =>
    send(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  return {
    async append(event: EventInput) {
      await post(`/run/ingest/runs/${encodeURIComponent(event.runId)}/events`, event);
    },
    async load(threadId) {
      const response = await send(
        `/run/ingest/threads/${encodeURIComponent(threadId)}/messages`,
        {},
      );
      return ((await response.json()) as { messages: string[] }).messages;
    },
    async appendMessage(threadId, idx, message) {
      try {
        await post(`/run/ingest/threads/${encodeURIComponent(threadId)}/messages`, {
          idx,
          message,
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
