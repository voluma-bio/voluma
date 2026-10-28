/**
 * The runner's routes, under /ingest/ and guarded for the runner (`service` principal);
 * the hand-off is `@voluma/contracts/runner`:
 *   POST /ingest/claim                                   take the oldest run the limits allow
 *   POST /ingest/runs/:runId/heartbeat | /report         extend the lease; end or release the run
 *   POST /ingest/runs/:runId/events                      append an event (EventInput)
 *   GET  /ingest/runs/:runId/events?after=&limit=        stored events after a seq, paged (RunEventsResponse)
 *   POST /ingest/runs/:runId/threads/:threadId/messages  append a history row {idx, message}
 *   GET  /ingest/runs/:runId/threads/:threadId/messages  all rows in order
 * Every route on a run carries the lease token (400 when missing); a stale one is a 409
 * `lease-lost`, checked in the write's own transaction. A thread id must begin with
 * `<runId>.`, else 400: the path's thread, and the event's `threadId` and `parentThreadId`.
 * An event id stored under another run is a 409. A claim returns a visitor run's keys once (pg-queue.ts).
 */
import { eventInputSchema, type RunEventsResponse } from "@voluma/contracts/events";
import { type HistoryResponse, historyRowSchema } from "@voluma/contracts/history";
import {
  type ClaimResponse,
  claimRequestSchema,
  type HeartbeatResponse,
  heartbeatRequestSchema,
  LEASE_TOKEN_HEADER,
  type leaseLostSchema,
  reportRequestSchema,
} from "@voluma/contracts/runner";
import { HistoryConflict } from "@voluma/harness/ports/history";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { z } from "zod";
import { type AppEnv, parseJson, requireService } from "../../domain";
import type { RunDeps } from ".";
import { LeaseLost } from "./lease";
import { EventIdTaken } from "./pg-event-log";
import { RunEnded } from "./pg-queue";

type IngestEnv = { Variables: AppEnv["Variables"] & { leaseToken: string } };

// Postgres text cannot hold a raw NUL; the harness's JSON.stringify output escapes it.
const storableRow = historyRowSchema.refine(
  (row) => !row.message.includes("\0"),
  "message contains a NUL byte",
);

/** A thread id carries its run's id, so one run can't write another's threads. */
const inRun = (runId: string, threadId: string) => threadId.startsWith(`${runId}.`);
const NOT_IN_RUN = "thread id must begin with <runId>.";

const MAX_PAGE = 1000;

function intParam(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined) return fallback;
  if (!/^\d{1,9}$/.test(raw))
    throw new HTTPException(400, { message: `${name} must be a non-negative integer` });
  return Number(raw);
}

export function ingestRoutes({ queue, eventLog, history, catalog }: RunDeps) {
  const app = new Hono<IngestEnv>();
  app.use("/ingest/*", requireService);

  // A stale lease is the contract's 409; the other conflicts carry their message.
  // Anything else goes to the root's handler.
  app.onError((error, c) => {
    if (error instanceof LeaseLost) {
      return c.json({ code: "lease-lost" } satisfies z.infer<typeof leaseLostSchema>, 409);
    }
    if (error instanceof RunEnded || error instanceof EventIdTaken) {
      return c.json({ error: error.message }, 409);
    }
    if (error instanceof HistoryConflict) return c.text(error.message, 409);
    throw error;
  });

  app.post("/ingest/claim", async (c) => {
    const { runnerId } = await parseJson(c, claimRequestSchema);
    const claimed = await queue.claim(runnerId);
    if (!claimed) return c.json({ claim: null } satisfies ClaimResponse);
    const { run, workflowId, leaseToken, keys } = claimed;
    const entry = catalog[workflowId];
    if (!entry)
      throw new Error(`run ${run.id} names workflow ${workflowId}, which is not in the catalog`);
    return c.json({
      claim: { run, plan: entry.plan, leaseToken, ...(keys && { keys }) },
    } satisfies ClaimResponse);
  });

  app.use("/ingest/runs/:runId/*", async (c, next) => {
    const token = c.req.header(LEASE_TOKEN_HEADER);
    if (!token) throw new HTTPException(400, { message: `missing ${LEASE_TOKEN_HEADER} header` });
    c.set("leaseToken", token);
    await next();
  });

  app.post("/ingest/runs/:runId/heartbeat", async (c) => {
    const { usage } = await parseJson(c, heartbeatRequestSchema);
    return c.json(
      (await queue.heartbeat(
        c.req.param("runId"),
        c.var.leaseToken,
        usage,
      )) satisfies HeartbeatResponse,
    );
  });

  app.post("/ingest/runs/:runId/report", async (c) => {
    const { report } = await parseJson(c, reportRequestSchema);
    await queue.report(c.req.param("runId"), c.var.leaseToken, report);
    return c.body(null, 204);
  });

  app.post("/ingest/runs/:runId/events", async (c) => {
    const event = await parseJson(c, eventInputSchema);
    if (event.runId !== c.req.param("runId")) {
      throw new HTTPException(400, { message: "event runId does not match the path" });
    }
    const threads = [event.threadId];
    if (event.type === "thread.started" && event.payload.parentThreadId) {
      threads.push(event.payload.parentThreadId);
    }
    if (!threads.every((thread) => inRun(event.runId, thread))) {
      throw new HTTPException(400, { message: NOT_IN_RUN });
    }
    await eventLog.append(event, c.var.leaseToken);
    return c.body(null, 204);
  });

  app.get("/ingest/runs/:runId/events", async (c) => {
    const after = intParam(c.req.query("after"), 0, "after");
    const limit = Math.min(intParam(c.req.query("limit"), MAX_PAGE, "limit"), MAX_PAGE);
    if (limit < 1) throw new HTTPException(400, { message: "limit must be at least 1" });
    const page = await eventLog.readLeased(
      c.req.param("runId"),
      c.var.leaseToken,
      after,
      limit + 1,
    );
    return c.json({
      events: page.slice(0, limit),
      more: page.length > limit,
    } satisfies RunEventsResponse);
  });

  app.use("/ingest/runs/:runId/threads/:threadId/*", async (c, next) => {
    const { runId, threadId } = c.req.param();
    if (!inRun(runId, threadId)) throw new HTTPException(400, { message: NOT_IN_RUN });
    await next();
  });

  app.get("/ingest/runs/:runId/threads/:threadId/messages", async (c) => {
    const { runId, threadId } = c.req.param();
    const messages = await history.load(runId, threadId, c.var.leaseToken);
    return c.json({ messages } satisfies HistoryResponse);
  });

  app.post("/ingest/runs/:runId/threads/:threadId/messages", async (c) => {
    const row = await parseJson(c, storableRow);
    const { runId, threadId } = c.req.param();
    await history.appendMessage(runId, threadId, row.idx, row.message, c.var.leaseToken);
    return c.body(null, 204);
  });

  return app;
}
