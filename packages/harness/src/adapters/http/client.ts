/**
 * The HTTP client for the EventLog and History ports: the run domain's routes
 * with the bearer token. Appends are idempotent on the server (an event id or a
 * history idx repeated with the same content is a no-op), so network and 5xx
 * failures retry.
 */
import type { EventInput } from "@voluma/contracts/events";
import type { EventLog } from "../../ports/event-log";
import type { History } from "../../ports/history";

const ATTEMPTS = 4;

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
        });
        if (response.status < 500) {
          if (!response.ok) {
            throw new NonRetryable(`${path}: ${response.status} ${await response.text()}`);
          }
          return response;
        }
        lastError = new Error(`${path}: ${response.status} ${await response.text()}`);
      } catch (error) {
        if (error instanceof NonRetryable) throw new Error(error.message);
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
      await post(`/run/runs/${encodeURIComponent(event.runId)}/events`, event);
    },
    async load(threadId) {
      const response = await send(`/run/threads/${encodeURIComponent(threadId)}/messages`, {});
      return ((await response.json()) as { messages: string[] }).messages;
    },
    async appendMessage(threadId, idx, message) {
      await post(`/run/threads/${encodeURIComponent(threadId)}/messages`, { idx, message });
    },
  };
}

class NonRetryable extends Error {}
