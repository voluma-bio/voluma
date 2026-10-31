/** Authorized screenshot saves: validate, store pixels, then publish immutable metadata. */
import { createHash } from "node:crypto";
import {
  createReviewSnapshotRequestSchema,
  MAX_REVIEW_SNAPSHOT_BYTES,
  type ReviewSnapshot,
  reviewSnapshotSchema,
} from "@voluma/contracts/snapshot";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import sharp from "sharp";
import { parseJson, readerOf, requireUser, type UserEnv } from "../../domain";
import type { ReviewDeps } from ".";
import { saveEvidence } from "./files";
import { reviewRun } from "./review-run";

function sameCapture(a: ReviewSnapshot, b: ReviewSnapshot) {
  return (
    a.revisionId === b.revisionId &&
    a.taskId === b.taskId &&
    a.png.sha256 === b.png.sha256 &&
    JSON.stringify(a.viewState) === JSON.stringify(b.viewState)
  );
}

export function snapshotRoutes({ runs, store, snapshots }: ReviewDeps) {
  const app = new Hono<UserEnv>();
  app.use("/runs/:runId/snapshots", requireUser);
  app.get("/runs/:runId/snapshots", async (c) => {
    if (c.req.method !== "GET") throw new HTTPException(405, { message: "Use GET." });
    const runId = c.req.param("runId");
    const run = await runs.readable(readerOf(c.var.user), runId);
    if (!run) return c.json({ error: "not found" }, 404);
    return c.json({ snapshots: await snapshots.list(runId, run.generation) });
  });
  app.post("/runs/:runId/snapshots", async (c) => {
    const runId = c.req.param("runId");
    const record = await runs.load(readerOf(c.var.user), runId);
    if (!record) return c.json({ error: "not found" }, 404);
    const body = await c.req.json().catch(() => undefined);
    if (
      typeof body?.pngBase64 === "string" &&
      body.pngBase64.length > 4 * Math.ceil(MAX_REVIEW_SNAPSHOT_BYTES / 3)
    )
      throw new HTTPException(413, { message: "Screenshot exceeds 8 MiB." });
    const request = await parseJson(c, createReviewSnapshotRequestSchema);
    const revision = reviewRun(record)?.revisions.find((r) => r.id === request.revisionId);
    if (!revision?.tasks.some((t) => t.id === request.taskId))
      return c.json({ error: "Revision or task not found." }, 404);
    const state = request.viewState;
    if (state.kind === "acquired")
      throw new HTTPException(400, {
        message: "Screenshots of the earlier DICOM viewer are no longer saved.",
      });
    // The grid's shape is its image's; the point must lie on it.
    const image = revision.volumes.find((v) => v.gridId === state.gridId && v.kind === "image");
    const shown = new Set([...revision.structures, ...revision.surfaces].map((s) => s.id));
    const blocks = new Set(
      [
        ...revision.volumes,
        ...revision.structures,
        ...revision.surfaces,
        ...revision.annotations,
      ].map((block) => block.id),
    );
    if (
      !image ||
      state.point.some((p, i) => p >= (image.shapeZyx[i] ?? 0)) ||
      state.structures.some((s) => !shown.has(s.structureId)) ||
      state.focus?.on.some((id) => !blocks.has(id)) ||
      (state.focus?.volumeId !== undefined &&
        !revision.volumes.some(
          (v) =>
            v.id === state.focus?.volumeId &&
            (state.focus?.label === undefined || v.kind === "labels"),
        ))
    )
      throw new HTTPException(400, { message: "Snapshot references are outside this revision." });

    const bytes = Buffer.from(request.pngBase64, "base64");
    if (bytes.length > MAX_REVIEW_SNAPSHOT_BYTES)
      throw new HTTPException(413, { message: "Screenshot exceeds 8 MiB." });
    try {
      if (!bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")))
        throw new Error("Not a PNG.");
      // libvips decodes only APNG's default frame and does not report its page count.
      let end = false;
      for (let offset = 8; offset < bytes.length; ) {
        if (bytes.length - offset < 12) throw new Error("Truncated PNG chunk.");
        const length = bytes.readUInt32BE(offset);
        const type = bytes.toString("ascii", offset + 4, offset + 8);
        offset += length + 12;
        if (offset > bytes.length || type === "acTL") throw new Error("Not a static PNG.");
        if (type === "IEND") {
          if (length !== 0 || offset !== bytes.length) throw new Error("Invalid PNG ending.");
          end = true;
        }
      }
      if (!end) throw new Error("Missing PNG ending.");
      // Decode, not just an IHDR check. libvips bounds allocation before trusting image dimensions.
      const image = sharp(bytes, { limitInputPixels: 16_777_216, failOn: "warning" });
      const metadata = await image.metadata();
      if (
        metadata.format !== "png" ||
        metadata.width !== state.viewport.width ||
        metadata.height !== state.viewport.height ||
        (metadata.pages ?? 1) !== 1
      )
        throw new Error("PNG dimensions must match the saved viewport.");
      await image.raw().toBuffer();
    } catch {
      throw new HTTPException(415, { message: "Invalid PNG or mismatched viewport dimensions." });
    }
    const snapshot = reviewSnapshotSchema.parse({
      ...request,
      runId,
      by: c.var.user.userId,
      createdAt: new Date().toISOString(),
      png: { sha256: createHash("sha256").update(bytes).digest("hex"), byteLength: bytes.length },
    });
    const existing = await snapshots.find(runId, record.generation, request.id);
    if (existing) {
      if (!sameCapture(existing, snapshot))
        throw new HTTPException(409, {
          message: "Snapshot id already belongs to another capture.",
        });
      return c.json(existing);
    }
    if (!store) throw new HTTPException(503, { message: "File storage is not configured." });
    await saveEvidence(store, runId, snapshot.png.sha256, bytes, c.req.raw.signal);
    const saved = await snapshots.insert(snapshot, record.generation);
    if ((await runs.readable(readerOf(c.var.user), runId))?.generation !== record.generation)
      throw new HTTPException(409, { message: "This run was replaced. Reload the run." });
    if (!sameCapture(saved.snapshot, snapshot))
      throw new HTTPException(409, { message: "Snapshot id already belongs to another capture." });
    return c.json(saved.snapshot, saved.created ? 201 : 200);
  });
  return app;
}
