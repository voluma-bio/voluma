/**
 * Run lane's API domain, mounted at /run/. Today: the stream record and the
 * model history of a run's threads, behind a bearer token.
 *   POST /run/runs/:runId/events          append an event (EventInput)
 *   POST /run/threads/:threadId/messages  append a history row {idx, message}
 *   GET  /run/threads/:threadId/messages  all rows in order
 * Later: workflows and their package import, runs, the supervisor. RunDeps lists
 * what it needs; index.ts supplies adapters.
 */
import { eventInputSchema } from "@voluma/contracts/events";
import type { EventLog } from "@voluma/harness/ports/event-log";
import { type History, HistoryConflict } from "@voluma/harness/ports/history";
import { z } from "zod";
import type { DomainHandler } from "../../domain";

export interface RunDeps {
  eventLog: EventLog;
  history: History;
  /** Callers present this as `Authorization: Bearer <token>`. */
  apiToken: string;
}

const historyRowSchema = z.object({ idx: z.number().int().nonnegative(), message: z.string() });

export function createRun({ eventLog, history, apiToken }: RunDeps): DomainHandler {
  return async (request) => {
    if (request.headers.get("authorization") !== `Bearer ${apiToken}`) {
      return new Response("Unauthorized", { status: 401 });
    }
    const { pathname } = new URL(request.url);
    const events = /^\/run\/runs\/([^/]+)\/events$/.exec(pathname);
    if (events && request.method === "POST") {
      const parsed = eventInputSchema.safeParse(await readJson(request));
      if (!parsed.success) return badRequest(parsed.error.message);
      if (parsed.data.runId !== decodeURIComponent(events[1] as string)) {
        return badRequest("event runId does not match the path");
      }
      await eventLog.append(parsed.data);
      return new Response(null, { status: 204 });
    }
    const messages = /^\/run\/threads\/([^/]+)\/messages$/.exec(pathname);
    if (messages) {
      const threadId = decodeURIComponent(messages[1] as string);
      if (request.method === "GET")
        return Response.json({ messages: await history.load(threadId) });
      if (request.method === "POST") {
        const parsed = historyRowSchema.safeParse(await readJson(request));
        if (!parsed.success) return badRequest(parsed.error.message);
        try {
          await history.appendMessage(threadId, parsed.data.idx, parsed.data.message);
        } catch (error) {
          if (error instanceof HistoryConflict) return new Response(error.message, { status: 409 });
          throw error;
        }
        return new Response(null, { status: 204 });
      }
    }
    return null;
  };
}

const readJson = (request: Request) => request.json().catch(() => undefined);
const badRequest = (message: string) => new Response(message, { status: 400 });
