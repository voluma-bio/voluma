/**
 * The review's run routes, for users only. Reads are scoped by `readerOf`, so a run the
 * caller can't read is 404.
 *   GET /runs/:runId                the run's review data (`@voluma/contracts/review`),
 *                                   built from its event log on each read
 *   GET /runs/:runId/files/:sha256  one of its files (`evidenceKey`), streamed from storage
 *   GET /runs/:runId/outputs/*      a file under its outputs (`outputsPrefix`): an output
 *                                   version's files and evidence, the agent loop's runs
 *   GET /runs/:runId/assets/:sha256/*  a converted review asset (`reviewAssetKey`): a 302 to
 *                                   a presigned GET, the browser fetches the bytes from storage
 *   GET /runs/:runId/thumbnail      a small WebP of the run, rendered once and kept (`thumbnail.ts`);
 *                                   204 while the run has no converted intensity image yet
 *   GET /runs/:runId/messages/:messageId/snapshot  the PNG attached to a message (`messageSnapshotKey`)
 *   POST /runs/:runId/tocheck/accept  Looks right on a To check item of an output version
 *                                   (`acceptToCheckRequestSchema`, the agent loop's runs)
 *   POST /runs/:runId/views         a view of an output the researcher saved
 *                                   (`saveViewRequestSchema`, the agent loop's runs)
 *   POST /runs/:runId/marks         a mark the researcher placed or changed (`placeMarkRequestSchema`)
 *   DELETE /runs/:runId/marks/:markId  a mark the researcher took away
 *   POST /runs/:runId/messages      a researcher's message to the run (`@voluma/contracts/messages`):
 *                                   the snapshot is checked and stored here, the Run domain judges
 *                                   and stores the message
 *   POST /runs/:runId/approvals/:requestId  the researcher's yes or no to a held call
 *                                   (`answerApprovalRequestSchema`, the agent loop's runs)
 */
import {
  acceptToCheckRequestSchema,
  MAX_MARK_BYTES,
  MAX_VIEW_BYTES,
  placeMarkRequestSchema,
  saveViewRequestSchema,
} from "@voluma/contracts/agent-events";
import {
  answerApprovalRequestSchema,
  MAX_MESSAGE_SNAPSHOT_BYTES,
  type PersonMessage,
  type SendRunMessageResponse,
  sendRunMessageRequestSchema,
} from "@voluma/contracts/messages";
import {
  evidenceKey,
  messageSnapshotKey,
  outputsPrefix,
  relativePathSchema,
  sha256Schema,
} from "@voluma/contracts/r2";
import {
  acceptCheckRequestSchema,
  markReviewedRequestSchema,
  type ReviewDecisionResponse,
} from "@voluma/contracts/review";
import { acceptRefusal } from "@voluma/contracts/run";
import { type Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { callerOf, parseJson, readerOf, requireUser, type UserEnv } from "../../domain";
import type { RunRecord } from "../../ports";
import type { ReviewDeps } from ".";
import { assetUrl, openFile } from "./files";
import { reviewRun } from "./review-run";
import { runThumbnail } from "./thumbnail";

/** The image types a browser may render inline, by their leading bytes; anything else downloads. */
function imageType(head: Uint8Array): string | null {
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image/jpeg";
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (png.every((byte, i) => head[i] === byte)) return "image/png";
  const ascii = (from: number, to: number) => String.fromCharCode(...head.subarray(from, to));
  if (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a") return "image/gif";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  return null;
}

function currentReview(record: RunRecord, baseRevisionId: string) {
  const refusal = acceptRefusal(record.run);
  if (refusal) throw new HTTPException(refusal.status, { message: refusal.message });
  const review = record.run.review;
  if (review?.revisionId !== baseRevisionId)
    throw new HTTPException(409, { message: "Results changed. Reload the run." });
  return review;
}

/** A decision's answer: the run's review data, whose `review` a decided run always has. */
function decisionResponse(record: RunRecord): ReviewDecisionResponse {
  const run = reviewRun(record);
  if (!run?.review) throw new Error(`run ${record.run.id} has no review after a decision`);
  return { ...run, review: run.review };
}

export function runRoutes({ runs, store, messages }: ReviewDeps) {
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
    const { baseRevisionId, taskId, resultRevisionId } = await parseJson(
      c,
      acceptCheckRequestSchema,
    );
    const { runId, checkId } = c.req.param();
    const record = await runs.decide(readerOf(c.var.user), runId, (record) => {
      currentReview(record, baseRevisionId);
      const task = record.results.revisions.at(-1)?.tasks.find((task) => task.id === taskId);
      if (!task) throw new HTTPException(404, { message: "Check not found." });
      if (task.resultRevisionId !== resultRevisionId)
        throw new HTTPException(409, { message: "This task's result changed. Look again." });
      const check = task.checks.find((check) => check.id === checkId);
      if (!check) throw new HTTPException(404, { message: "Check not found." });
      if (check.status === "accepted") return null;
      return {
        type: "check.accepted",
        payload: {
          by: c.var.user.userId,
          revisionId: baseRevisionId,
          taskId,
          checkId,
          resultRevisionId,
        },
      };
    });
    if (!record) return c.json({ error: "not found" }, 404);
    return c.json(decisionResponse(record));
  });

  app.post("/runs/:runId/mark-reviewed", async (c) => {
    const { baseRevisionId } = await parseJson(c, markReviewedRequestSchema);
    const record = await runs.decide(readerOf(c.var.user), c.req.param("runId"), (record) => {
      const review = currentReview(record, baseRevisionId);
      if (review.acceptable !== 0)
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
    return c.json(decisionResponse(record));
  });

  app.post("/runs/:runId/tocheck/accept", async (c) => {
    const { output, version, item } = await parseJson(c, acceptToCheckRequestSchema);
    const record = await runs.decide(readerOf(c.var.user), c.req.param("runId"), (record) => {
      if (record.run.example)
        throw new HTTPException(403, { message: "Example runs can't be changed." });
      const published = record.results.outputs.byId
        .get(output)
        ?.versions.find((v) => v.version === version);
      const check = published?.toCheck[item];
      if (!check) throw new HTTPException(404, { message: "To check item not found." });
      if (check.resolved) return null;
      return {
        type: "tocheck.resolved",
        payload: { output, version, item, by: c.var.user.userId, outcome: "accepted" },
      };
    });
    if (!record) return c.json({ error: "not found" }, 404);
    return c.json({});
  });

  app.post("/runs/:runId/views", async (c) => {
    const { output, view } = await parseJson(c, saveViewRequestSchema);
    if (JSON.stringify(view).length > MAX_VIEW_BYTES)
      return c.json({ error: "The view is too large." }, 413);
    const record = await runs.decide(readerOf(c.var.user), c.req.param("runId"), (record) => {
      if (record.run.example)
        throw new HTTPException(403, { message: "Example runs can't be changed." });
      if (!record.results.outputs.byId.has(output))
        throw new HTTPException(404, { message: "Output not found." });
      return { type: "view.saved", payload: { output, view } };
    });
    if (!record) return c.json({ error: "not found" }, 404);
    return c.json({});
  });

  app.post("/runs/:runId/marks", async (c) => {
    const body = await parseJson(c, placeMarkRequestSchema);
    if (JSON.stringify(body).length > MAX_MARK_BYTES)
      return c.json({ error: "The mark is too large." }, 413);
    const record = await runs.decide(readerOf(c.var.user), c.req.param("runId"), (record) => {
      if (record.run.example)
        throw new HTTPException(403, { message: "Example runs can't be changed." });
      if (!record.results.outputs.byId.has(body.output))
        throw new HTTPException(404, { message: "Output not found." });
      return { type: "mark.placed", payload: { ...body, by: c.var.user.userId } };
    });
    if (!record) return c.json({ error: "not found" }, 404);
    return c.json({});
  });

  app.delete("/runs/:runId/marks/:markId", async (c) => {
    const id = z.uuid().safeParse(c.req.param("markId"));
    if (!id.success) return c.json({ error: "not found" }, 404);
    const record = await runs.decide(readerOf(c.var.user), c.req.param("runId"), (record) => {
      if (record.run.example)
        throw new HTTPException(403, { message: "Example runs can't be changed." });
      // Only the author's deletion counts, so any other would be a pointless stored event.
      if (record.results.marks.get(id.data)?.by !== c.var.user.userId)
        throw new HTTPException(404, { message: "Mark not found." });
      return { type: "mark.deleted", payload: { id: id.data, by: c.var.user.userId } };
    });
    if (!record) return c.json({ error: "not found" }, 404);
    return c.json({});
  });

  app.post("/runs/:runId/messages", async (c) => {
    const { id, snapshot, markIds, ...rest } = await parseJson(c, sendRunMessageRequestSchema);
    const { runId } = c.req.param();
    const user = c.var.user;
    const reader = readerOf(user);
    const caller = callerOf(user);

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
    const message = { id, payload, ...(markIds && { markIds }) };

    const checked = await messages.check(reader, caller, runId, message);
    if (!checked.duplicate && png) {
      if (!store) throw new HTTPException(503, { message: "File storage is not configured." });
      await store.put(messageSnapshotKey(runId, id), png, { contentType: "image/png" });
    }
    const { eventId, state } = await messages.send(reader, caller, runId, message);
    return c.json({ eventId, state } satisfies SendRunMessageResponse);
  });

  app.post("/runs/:runId/approvals/:requestId", async (c) => {
    const body = await parseJson(c, answerApprovalRequestSchema);
    const { runId, requestId } = c.req.param();
    await messages.answer(readerOf(c.var.user), callerOf(c.var.user), runId, requestId, body);
    return c.json({});
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
    if (!store) throw new HTTPException(503, { message: "File storage is not configured." });
    // The stored content type is whatever the sandbox's mount wrote, so the bytes decide.
    // Content-addressed: the bytes never change. A day, so a revoked reader's copy doesn't linger.
    return serveFile(
      c,
      await openFile(store, evidenceKey(runId, sha256), c.req.raw.signal),
      "private, max-age=86400, immutable",
    );
  });

  app.get("/runs/:runId/outputs/*", async (c) => {
    if (c.req.method !== "GET") throw new HTTPException(405, { message: "Use GET." });
    const { runId } = c.req.param();
    const marker = `/runs/${runId}/outputs/`;
    const at = c.req.path.indexOf(marker);
    const tail = at < 0 ? "" : decodeTail(c.req.path.slice(at + marker.length));
    if (!relativePathSchema.safeParse(tail).success) return c.json({ error: "not found" }, 404);
    if (!(await runs.readable(readerOf(c.var.user), runId)))
      return c.json({ error: "not found" }, 404);
    if (!store) throw new HTTPException(503, { message: "File storage is not configured." });
    // The sandbox mounts the outputs read-write, so a published file's key can be rewritten.
    return serveFile(
      c,
      await openFile(store, `${outputsPrefix(runId)}${tail}`, c.req.raw.signal),
      "private, no-cache",
    );
  });

  app.get("/runs/:runId/messages/:messageId/snapshot", async (c) => {
    const { runId, messageId } = c.req.param();
    if (!z.uuid().safeParse(messageId).success) return c.json({ error: "not found" }, 404);
    if (!(await runs.readable(readerOf(c.var.user), runId)))
      return c.json({ error: "not found" }, 404);
    if (!store) throw new HTTPException(503, { message: "File storage is not configured." });
    // Written once under the message's id, never rewritten.
    return serveFile(
      c,
      await openFile(store, messageSnapshotKey(runId, messageId), c.req.raw.signal),
      "private, max-age=86400, immutable",
    );
  });

  app.get("/runs/:runId/thumbnail", async (c) => {
    const { runId } = c.req.param();
    const reader = readerOf(c.var.user);
    const readable = await runs.readable(reader, runId);
    if (!readable) return c.json({ error: "not found" }, 404);
    if (!store) throw new HTTPException(503, { message: "File storage is not configured." });
    const webp = await runThumbnail(store, runId, readable.generation, async () => {
      const record = await runs.load(reader, runId);
      return record?.results.assets ?? null;
    });
    // Nothing to show yet: a list asks again on its next load, so this is not cached.
    if (!webp) {
      c.header("Cache-Control", "no-store");
      return c.body(null, 204);
    }
    c.header("Content-Type", "image/webp");
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Cache-Control", "private, max-age=3600");
    return c.body(webp as Uint8Array<ArrayBuffer>);
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
    if (!store) throw new HTTPException(503, { message: "File storage is not configured." });
    const { url, validSeconds } = await assetUrl(store, runId, sha256, tail);
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
