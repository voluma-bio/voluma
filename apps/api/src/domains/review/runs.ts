/**
 * The review's run routes, for users only. Reads are scoped by `readerOf`, so a run the
 * caller can't read is 404.
 *   GET /runs/:runId                the run's review data (`@voluma/contracts/review`),
 *                                   built from its event log on each read
 *   GET /runs/:runId/files/:sha256  one of its files (`evidenceKey`), streamed from storage
 *   GET /runs/:runId/assets/:sha256/*  a converted review asset (`reviewAssetKey`): a 302 to
 *                                   a presigned GET, the browser fetches the bytes from storage
 *   GET /runs/:runId/messages/:messageId/snapshot  the PNG attached to a message (`messageSnapshotKey`)
 *   POST /runs/:runId/messages      a researcher's message to the run (`@voluma/contracts/messages`):
 *                                   the snapshot is checked and stored here, the Run domain judges
 *                                   and stores the message
 */
import {
  MAX_MESSAGE_SNAPSHOT_BYTES,
  type PersonMessage,
  type SendRunMessageResponse,
  sendRunMessageRequestSchema,
} from "@voluma/contracts/messages";
import { messageSnapshotKey, relativePathSchema, sha256Schema } from "@voluma/contracts/r2";
import {
  acceptCheckRequestSchema,
  markReviewedRequestSchema,
  reviewDecisionResponseSchema,
} from "@voluma/contracts/review";
import { type Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { parseJson, readerOf, requireUser, type UserEnv } from "../../domain";
import type { RunRecord } from "../../ports";
import type { ReviewDeps } from ".";
import { reviewRun } from "./review-run";

/** The image types a browser may render inline, by their leading bytes; anything else downloads. */
function imageType(head: Uint8Array): string | null {
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image/jpeg";
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (png.every((byte, i) => head[i] === byte)) return "image/png";
  return null;
}

function currentReview(record: RunRecord, baseRevisionId: string) {
  if (record.run.example) throw new HTTPException(403, { message: "Example runs are read-only." });
  const review = record.run.review;
  if (!review || review.revisionId !== baseRevisionId)
    throw new HTTPException(409, {
      message: "Results changed or are not completed. Reload the run.",
    });
  return review;
}

export function runRoutes({ runs, files, messages }: ReviewDeps) {
  const app = new Hono<UserEnv>();
  app.use("/runs/*", requireUser);

  app.get("/runs/:runId", async (c) => {
    const record = await runs.load(readerOf(c.var.user), c.req.param("runId"));
    if (!record) return c.json({ error: "not found" }, 404);
    const review = reviewRun(record);
    if (!review) return c.json({ error: "this run has no plan" }, 409);
    return c.json(review);
  });

  app.post("/runs/:runId/checks/:checkId/accept", async (c) => {
    const { baseRevisionId, taskId } = await parseJson(c, acceptCheckRequestSchema);
    const { runId, checkId } = c.req.param();
    const record = await runs.decide(readerOf(c.var.user), runId, (record) => {
      currentReview(record, baseRevisionId);
      const task = record.results.revisions.at(-1)?.tasks.find((task) => task.id === taskId);
      const check = task?.checks.find((check) => check.id === checkId);
      if (!task || !check) throw new HTTPException(404, { message: "Check not found." });
      if (check.status === "accepted") return null;
      return {
        type: "check.accepted",
        payload: {
          by: c.var.user.userId,
          revisionId: baseRevisionId,
          taskId,
          checkId,
          resultRevisionId: task.resultRevisionId,
        },
      };
    });
    if (!record) return c.json({ error: "not found" }, 404);
    return c.json(reviewDecisionResponseSchema.parse(reviewRun(record)));
  });

  app.post("/runs/:runId/mark-reviewed", async (c) => {
    const { baseRevisionId } = await parseJson(c, markReviewedRequestSchema);
    const record = await runs.decide(readerOf(c.var.user), c.req.param("runId"), (record) => {
      const review = currentReview(record, baseRevisionId);
      if (review.remainingToCheck !== 0)
        throw new HTTPException(409, {
          message: "Accept every To check item before marking reviewed.",
        });
      if (review.reviewedAt) return null;
      return {
        type: "review.completed",
        payload: { by: c.var.user.userId, revisionId: baseRevisionId },
      };
    });
    if (!record) return c.json({ error: "not found" }, 404);
    return c.json(reviewDecisionResponseSchema.parse(reviewRun(record)));
  });

  app.post("/runs/:runId/messages", async (c) => {
    const { id, snapshot, ...rest } = await parseJson(c, sendRunMessageRequestSchema);
    const { runId } = c.req.param();
    const user = c.var.user;
    const reader = readerOf(user);
    const caller = { userId: user.userId, guest: user.account === "visitor" };
    const refusedAs = (r: { status: 403 | 404 | 409 | 429; error: string }) =>
      c.json({ error: r.error }, r.status);

    let png: Uint8Array | undefined;
    if (snapshot) {
      png = Buffer.from(snapshot.data, "base64");
      if (png.length > MAX_MESSAGE_SNAPSHOT_BYTES)
        return c.json({ error: "The snapshot is too large." }, 413);
      if (imageType(png) !== "image/png")
        return c.json({ error: "The snapshot is not a PNG." }, 415);
    }
    const payload: PersonMessage = {
      ...rest,
      ...(png && { snapshotKey: messageSnapshotKey(runId, id) }),
    };
    const message = { id, payload };

    const checked = await messages.check(reader, caller, runId, message);
    if ("refused" in checked) return refusedAs(checked.refused);
    if (!checked.ok.duplicate && png) {
      if (!files) throw new HTTPException(503, { message: "File storage is not configured." });
      await files.putSnapshot(runId, id, png);
    }
    const sent = await messages.send(reader, caller, runId, message);
    if ("refused" in sent) return refusedAs(sent.refused);
    const { eventId, state } = sent.ok;
    return c.json({ eventId, state } satisfies SendRunMessageResponse);
  });

  /** Streams a stored file to the browser; the bytes decide whether it renders inline. */
  async function serveFile(
    c: Context<UserEnv>,
    file: { body: ReadableStream<Uint8Array>; byteLength: number },
    cacheControl: string,
  ) {
    const reader = file.body.getReader();
    const first = await reader.read();
    const head = first.value ?? new Uint8Array();
    const type = imageType(head);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        if (head.length) controller.enqueue(head);
        if (first.done) controller.close();
      },
      async pull(controller) {
        const next = await reader.read();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      },
      cancel: (reason) => reader.cancel(reason),
    });
    c.header("Content-Type", type ?? "application/octet-stream");
    c.header("Content-Length", String(file.byteLength));
    c.header("X-Content-Type-Options", "nosniff");
    if (!type) c.header("Content-Disposition", "attachment");
    c.header("Cache-Control", cacheControl);
    return c.body(stream);
  }

  app.get("/runs/:runId/files/:sha256", async (c) => {
    // Hono runs GET for HEAD and drops the body without cancelling the storage read.
    if (c.req.method !== "GET") throw new HTTPException(405, { message: "Use GET." });
    const { runId, sha256 } = c.req.param();
    if (!sha256Schema.safeParse(sha256).success) return c.json({ error: "not found" }, 404);
    if (!(await runs.readable(readerOf(c.var.user), runId)))
      return c.json({ error: "not found" }, 404);
    if (!files) throw new HTTPException(503, { message: "File storage is not configured." });
    // The stored content type is whatever the sandbox's mount wrote, so the bytes decide.
    // Content-addressed: the bytes never change. A day, so a revoked reader's copy doesn't linger.
    return serveFile(
      c,
      await files.open(runId, sha256, c.req.raw.signal),
      "private, max-age=86400, immutable",
    );
  });

  app.get("/runs/:runId/messages/:messageId/snapshot", async (c) => {
    const { runId, messageId } = c.req.param();
    if (!z.uuid().safeParse(messageId).success) return c.json({ error: "not found" }, 404);
    if (!(await runs.readable(readerOf(c.var.user), runId)))
      return c.json({ error: "not found" }, 404);
    if (!files) throw new HTTPException(503, { message: "File storage is not configured." });
    // Written once under the message's id, never rewritten.
    return serveFile(
      c,
      await files.openSnapshot(runId, messageId, c.req.raw.signal),
      "private, max-age=86400, immutable",
    );
  });

  app.get("/runs/:runId/assets/:sha256/*", async (c) => {
    const { runId, sha256 } = c.req.param();
    // Assets are keyed by run (`reviewAssetKey`), so the read check on the run is the whole scope check.
    const marker = `/assets/${sha256}/`;
    const tail = decodeTail(c.req.path.slice(c.req.path.indexOf(marker) + marker.length));
    if (!sha256Schema.safeParse(sha256).success || !relativePathSchema.safeParse(tail).success)
      return c.json({ error: "not found" }, 404);
    if (!(await runs.readable(readerOf(c.var.user), runId)))
      return c.json({ error: "not found" }, 404);
    if (!files) throw new HTTPException(503, { message: "File storage is not configured." });
    const { url, validSeconds } = await files.assetUrl(runId, sha256, tail);
    // The browser may reuse the redirect while its URL is still good (the same file asked for
    // again gets the same URL), with a margin to follow it.
    c.header("Cache-Control", `private, max-age=${Math.max(0, validSeconds - 30)}`);
    return c.redirect(url, 302);
  });

  return app;
}

function decodeTail(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return "";
  }
}
