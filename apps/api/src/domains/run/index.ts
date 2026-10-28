/**
 * Run lane's API domain, mounted at /api/run/ (paths below are relative to the mount).
 * Today: the runner's ingest of the stream record and the model history of a run's
 * threads, under /ingest/ and guarded for the runner (`service` principal; other routes will take `user`).
 *   POST /ingest/runs/:runId/events          append an event (EventInput)
 *   POST /ingest/threads/:threadId/messages  append a history row {idx, message}
 *   GET  /ingest/threads/:threadId/messages  all rows in order
 * Later: workflows and their package import, runs, the supervisor. RunDeps lists
 * what it needs; index.ts supplies adapters. The factory returns a Hono app, so
 * routes, params and (later) WebSocket upgrades use Hono; the domain does not know its mount.
 * The Postgres adapters and tables for it are in this directory.
 */
import { eventInputSchema } from "@voluma/contracts/events";
import { type HistoryResponse, historyRowSchema } from "@voluma/contracts/history";
import type { EventLog } from "@voluma/harness/ports/event-log";
import { type History, HistoryConflict } from "@voluma/harness/ports/history";
import { Hono } from "hono";
import { type AppEnv, requireService } from "../../domain";

export interface RunDeps {
  eventLog: EventLog;
  history: History;
}

// Postgres text cannot hold a raw NUL; the harness's JSON.stringify output escapes it.
const storableRow = historyRowSchema.refine(
  (row) => !row.message.includes("\0"),
  "message contains a NUL byte",
);

export function createRun({ eventLog, history }: RunDeps) {
  const app = new Hono<AppEnv>();
  app.use("/ingest/*", requireService);

  app.post("/ingest/runs/:runId/events", async (c) => {
    const parsed = eventInputSchema.safeParse(await readJson(c.req));
    if (!parsed.success) return c.text(parsed.error.message, 400);
    if (parsed.data.runId !== c.req.param("runId")) {
      return c.text("event runId does not match the path", 400);
    }
    await eventLog.append(parsed.data);
    return c.body(null, 204);
  });

  app.get("/ingest/threads/:threadId/messages", async (c) =>
    c.json({ messages: await history.load(c.req.param("threadId")) } satisfies HistoryResponse),
  );

  app.post("/ingest/threads/:threadId/messages", async (c) => {
    const parsed = storableRow.safeParse(await readJson(c.req));
    if (!parsed.success) return c.text(parsed.error.message, 400);
    try {
      await history.appendMessage(c.req.param("threadId"), parsed.data.idx, parsed.data.message);
    } catch (error) {
      if (error instanceof HistoryConflict) return c.text(error.message, 409);
      throw error;
    }
    return c.body(null, 204);
  });

  return app;
}

const readJson = (req: { json(): Promise<unknown> }) => req.json().catch(() => undefined);
