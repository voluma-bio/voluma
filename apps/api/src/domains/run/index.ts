/**
 * Run lane's API domain, mounted at /api/run/ (paths below are relative to the mount).
 * Today: the runner's ingest of the stream record and the model history of a run's
 * threads, under /ingest/ and behind a bearer token (other routes will use user auth).
 *   POST /ingest/runs/:runId/events          append an event (EventInput)
 *   POST /ingest/threads/:threadId/messages  append a history row {idx, message}
 *   GET  /ingest/threads/:threadId/messages  all rows in order
 * Later: workflows and their package import, runs, the supervisor. RunDeps lists
 * what it needs; index.ts supplies adapters.
 */
import { timingSafeEqual } from "node:crypto";
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
  return async (request, pathname) => {
    if (!pathname.startsWith(INGEST)) return null;
    if (!bearerMatches(request.headers.get("authorization"), apiToken)) {
      return new Response("Unauthorized", { status: 401 });
    }
    const events = /^\/ingest\/runs\/([^/]+)\/events$/.exec(pathname);
    if (events && request.method === "POST") {
      const runId = decode(events[1] as string);
      if (runId === undefined) return badRequest("malformed path");
      const parsed = eventInputSchema.safeParse(await readJson(request));
      if (!parsed.success) return badRequest(parsed.error.message);
      if (parsed.data.runId !== runId) {
        return badRequest("event runId does not match the path");
      }
      await eventLog.append(parsed.data);
      return new Response(null, { status: 204 });
    }
    const messages = /^\/ingest\/threads\/([^/]+)\/messages$/.exec(pathname);
    if (messages) {
      const threadId = decode(messages[1] as string);
      if (threadId === undefined) return badRequest("malformed path");
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

const INGEST = "/ingest/";

const decode = (segment: string) => {
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
};

const encoder = new TextEncoder();
// Constant time for equal lengths; the length of the expected header is not secret.
function bearerMatches(header: string | null, token: string): boolean {
  const given = encoder.encode(header ?? "");
  const expected = encoder.encode(`Bearer ${token}`);
  return given.byteLength === expected.byteLength && timingSafeEqual(given, expected);
}

const readJson = (request: Request) => request.json().catch(() => undefined);
const badRequest = (message: string) => new Response(message, { status: 400 });
