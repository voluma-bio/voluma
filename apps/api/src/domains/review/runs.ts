/**
 * The review's run routes, for users only. Reads are scoped by `readerOf`, so a run the
 * caller can't read is 404.
 *   GET /runs/:runId                the run's review data (`@voluma/contracts/review`),
 *                                   built from its event log on each read
 *   GET /runs/:runId/files/:sha256  one of its files (`evidenceKey`), streamed from storage
 *   GET /runs/:runId/assets/:sha256/*  a converted review asset (`reviewAssetKey`): a 302 to
 *                                   a presigned GET, the browser fetches the bytes from storage
 */
import { relativePathSchema, sha256Schema } from "@voluma/contracts/r2";
import {
  acceptCheckRequestSchema,
  markReviewedRequestSchema,
  reviewDecisionResponseSchema,
} from "@voluma/contracts/review";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
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

export function runRoutes({ runs, files }: ReviewDeps) {
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

  app.get("/runs/:runId/files/:sha256", async (c) => {
    // Hono runs GET for HEAD and drops the body without cancelling the storage read.
    if (c.req.method !== "GET") throw new HTTPException(405, { message: "Use GET." });
    const { runId, sha256 } = c.req.param();
    if (!sha256Schema.safeParse(sha256).success) return c.json({ error: "not found" }, 404);
    if (!(await runs.readable(readerOf(c.var.user), runId)))
      return c.json({ error: "not found" }, 404);
    if (!files) throw new HTTPException(503, { message: "File storage is not configured." });

    const { body, byteLength } = await files.open(runId, sha256, c.req.raw.signal);
    // The stored content type is whatever the sandbox's mount wrote, so the bytes decide.
    const reader = body.getReader();
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
    c.header("Content-Length", String(byteLength));
    c.header("X-Content-Type-Options", "nosniff");
    if (!type) c.header("Content-Disposition", "attachment");
    // Content-addressed: the bytes never change. A day, so a revoked reader's copy doesn't linger.
    c.header("Cache-Control", "private, max-age=86400, immutable");
    return c.body(stream);
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
    // The URL expires and the file does not change: the browser must ask again, not cache the redirect.
    c.header("Cache-Control", "no-store");
    return c.redirect(await files.assetUrl(runId, sha256, tail), 302);
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
