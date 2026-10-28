/**
 * The runner's routes, under /ingest/ and guarded for the runner (`service` principal);
 * the hand-off is `@voluma/contracts/runner`:
 *   POST /ingest/claim                                   take the oldest run the limits allow
 *   POST /ingest/runs/:runId/heartbeat | /report         extend the lease; end or release the run
 *   POST /ingest/runs/:runId/events                      append an event (EventInput)
 *   POST /ingest/runs/:runId/threads/:threadId/messages  append a history row {idx, message}
 *   GET  /ingest/runs/:runId/threads/:threadId/messages  all rows in order
 * Every route on a run carries the lease token (400 when missing); a stale one is a 409
 * `lease-lost`, checked in the write's own transaction. A thread id must begin with
 * `<runId>.`, else 400: the path's thread, and the event's `threadId` and `parentThreadId`.
 * An event id stored under another run is a 409. A claim's visitor keys leave the vault with the response.
 */
import { eventInputSchema } from "@voluma/contracts/events";
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
import { type Context, Hono } from "hono";
import type { z } from "zod";
import { type AppEnv, requireService } from "../../domain";
import type { Catalog } from "./catalog";
import type { KeyVault } from "./key-vault";
import {
  EventIdTaken,
  type LeasedEventLog,
  type LeasedHistory,
  LeaseLost,
  RunEnded,
  type RunQueue,
} from "./run-store";

export interface IngestDeps {
  queue: RunQueue;
  eventLog: LeasedEventLog;
  history: LeasedHistory;
  catalog: Catalog;
  vault: KeyVault;
}

type IngestEnv = { Variables: AppEnv["Variables"] & { leaseToken: string } };

// Postgres text cannot hold a raw NUL; the harness's JSON.stringify output escapes it.
const storableRow = historyRowSchema.refine(
  (row) => !row.message.includes("\0"),
  "message contains a NUL byte",
);

/** Runs a write and answers a stale lease as the contract's 409; anything else propagates. */
async function leased(c: Context, work: () => Promise<Response>): Promise<Response> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof LeaseLost) {
      return c.json({ code: "lease-lost" } satisfies z.infer<typeof leaseLostSchema>, 409);
    }
    if (error instanceof RunEnded || error instanceof EventIdTaken) {
      return c.json({ error: error.message }, 409);
    }
    throw error;
  }
}

const readJson = (req: { json(): Promise<unknown> }) => req.json().catch(() => undefined);

export function ingestRoutes({ queue, eventLog, history, catalog, vault }: IngestDeps) {
  const app = new Hono<IngestEnv>();
  app.use("/ingest/*", requireService);

  app.post("/ingest/claim", async (c) => {
    const parsed = claimRequestSchema.safeParse(await readJson(c.req));
    if (!parsed.success) return c.text(parsed.error.message, 400);
    const { claimed, dropped } = await queue.claim(parsed.data.runnerId, () => vault.ids());
    for (const runId of dropped) vault.drop(runId);
    if (!claimed) return c.json({ claim: null } satisfies ClaimResponse);
    const { run, workflowId, leaseToken } = claimed;
    const keys = run.credentials === "visitor" ? vault.take(run.id) : undefined;
    const entry = catalog[workflowId];
    if (!entry)
      throw new Error(`run ${run.id} names workflow ${workflowId}, which is not in the catalog`);
    return c.json({
      claim: { run, plan: entry.plan, leaseToken, ...(keys && { keys }) },
    } satisfies ClaimResponse);
  });

  app.use("/ingest/runs/:runId/*", async (c, next) => {
    const token = c.req.header(LEASE_TOKEN_HEADER);
    if (!token) return c.text(`missing ${LEASE_TOKEN_HEADER} header`, 400);
    c.set("leaseToken", token);
    await next();
  });

  app.post("/ingest/runs/:runId/heartbeat", async (c) => {
    const parsed = heartbeatRequestSchema.safeParse(await readJson(c.req));
    if (!parsed.success) return c.text(parsed.error.message, 400);
    return leased(c, async () =>
      c.json(
        (await queue.heartbeat(
          c.req.param("runId"),
          c.var.leaseToken,
          parsed.data.usage,
        )) satisfies HeartbeatResponse,
      ),
    );
  });

  app.post("/ingest/runs/:runId/report", async (c) => {
    const parsed = reportRequestSchema.safeParse(await readJson(c.req));
    if (!parsed.success) return c.text(parsed.error.message, 400);
    return leased(c, async () => {
      await queue.report(c.req.param("runId"), c.var.leaseToken, parsed.data.report);
      return c.body(null, 204);
    });
  });

  app.post("/ingest/runs/:runId/events", async (c) => {
    const parsed = eventInputSchema.safeParse(await readJson(c.req));
    if (!parsed.success) return c.text(parsed.error.message, 400);
    if (parsed.data.runId !== c.req.param("runId")) {
      return c.text("event runId does not match the path", 400);
    }
    const threads = [parsed.data.threadId];
    if (parsed.data.type === "thread.started" && parsed.data.payload.parentThreadId) {
      threads.push(parsed.data.payload.parentThreadId);
    }
    if (!threads.every((thread) => thread.startsWith(`${parsed.data.runId}.`))) {
      return c.text("thread id must begin with <runId>.", 400);
    }
    return leased(c, async () => {
      await eventLog.append(parsed.data, c.var.leaseToken);
      return c.body(null, 204);
    });
  });

  app.use("/ingest/runs/:runId/threads/:threadId/*", async (c, next) => {
    const { runId, threadId } = c.req.param();
    if (!threadId.startsWith(`${runId}.`)) return c.text("thread id must begin with <runId>.", 400);
    await next();
  });

  app.get("/ingest/runs/:runId/threads/:threadId/messages", (c) =>
    leased(c, async () => {
      const { runId, threadId } = c.req.param();
      const messages = await history.load(runId, threadId, c.var.leaseToken);
      return c.json({ messages } satisfies HistoryResponse);
    }),
  );

  app.post("/ingest/runs/:runId/threads/:threadId/messages", async (c) => {
    const parsed = storableRow.safeParse(await readJson(c.req));
    if (!parsed.success) return c.text(parsed.error.message, 400);
    const { runId, threadId } = c.req.param();
    return leased(c, async () => {
      try {
        await history.appendMessage(
          runId,
          threadId,
          parsed.data.idx,
          parsed.data.message,
          c.var.leaseToken,
        );
      } catch (error) {
        if (error instanceof HistoryConflict) return c.text(error.message, 409);
        throw error;
      }
      return c.body(null, 204);
    });
  });

  return app;
}
