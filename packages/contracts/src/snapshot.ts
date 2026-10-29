/**
 * Immutable review screenshots, separate from scientific outputs and workflow snapshots.
 *
 * POST /api/review/runs/:runId/snapshots accepts createReviewSnapshotRequestSchema.
 * The caller keeps its UUID across retries. First save: 201; an identical retry: 200,
 * returning the original record without changing its author or timestamp. An existing
 * id with different revision, task, view state or PNG bytes is 409, never an overwrite.
 * GET on that collection returns listReviewSnapshotsResponseSchema, oldest first.
 *
 * Both routes require a user and authorize through the run's reader. 404 for an
 * unreadable run or an unknown revision/task; 400 for malformed state or references
 * outside that revision; 413 for request/image limits; 415 for an invalid PNG;
 * 503 without storage, 502 for a storage failure. The server supplies by/createdAt,
 * validates PNG dimensions against viewState.viewport, and stores its bytes at
 * evidenceKey(runId, sha256) before publishing metadata. A failed save is not listed.
 * Reads of the PNG use the existing reviewFileUrl(runId, png.sha256).
 *
 * JSON keeps the existing cookie/Origin protections. Only the snapshot POST gets
 * a 12 MiB body limit; all other browser requests retain their existing limits.
 * PNG bytes are base64 (not a data URL), at most 8 MiB after decoding. The server
 * checks the decoded size and image validity, not only this string's syntax.
 *
 * Restore only after opening the pinned revision/task and matching the run input's
 * series and geometry fingerprint. Apply slice, camera and display settings after
 * images/labels load; focus must not subsequently recenter the saved camera. The
 * viewport's original aspect ratio is retained when reopening at another size.
 * The PNG is the original capture even if later display tokens/rendering change.
 * Export bundles keep this record and PNG under its id; {snapshot:id} resolves only
 * within the exported run/revision. These schemas prepare the routes; no handler
 * or report renderer is connected yet.
 */
import { z } from "zod";
import { userIdSchema } from "./auth";
import { runIdSchema, taskIdSchema } from "./ids";
import { sha256Schema } from "./r2";
import { focusSchema } from "./review";

export const MAX_REVIEW_SNAPSHOT_BYTES = 8 * 1024 * 1024;
export const REVIEW_SNAPSHOT_BODY_BYTES = 12 * 1024 * 1024;

const vec3 = z.tuple([z.number(), z.number(), z.number()]);
const id = z.string().min(1).max(256);
const percent = z.number().min(0).max(100);
const windowSchema = z
  .object({ lower: z.number(), upper: z.number() })
  .refine((w) => w.lower < w.upper, "window upper must exceed lower");

const cameraSchema = z
  .object({
    /** World mm, never canvas or voxel coordinates. */
    position: vec3,
    focalPoint: vec3,
    viewUp: vec3,
    parallelProjection: z.boolean(),
    /** Half the vertical visible world extent for parallel projection, in mm. */
    parallelScale: z.number().positive(),
    /** Vertical field of view in degrees for perspective projection. */
    viewAngle: z.number().positive().lt(180),
    flipHorizontal: z.boolean(),
    flipVertical: z.boolean(),
  })
  .refine((camera) => {
    const [px, py, pz] = camera.position;
    const [fx, fy, fz] = camera.focalPoint;
    const [x, y, z] = [fx - px, fy - py, fz - pz];
    const [u, v, w] = camera.viewUp;
    return Math.hypot(y * w - z * v, z * u - x * w, x * v - y * u) > 0;
  }, "camera needs distinct position/focal point and a nonparallel view-up vector");

const view = {
  version: z.literal(1),
  seriesId: id,
  /**
   * SHA-256 of UTF-8 JSON.stringify([rows, columns, spacing, orientation, positions]),
   * using the acquired series' ascending slice order and every slice's world-mm
   * position. This identifies geometry, not pixel content; the run input is immutable.
   */
  scanGeometrySha256: sha256Schema,
  /** Physical PNG pixels, including device pixel ratio. Maximum 16 megapixels. */
  viewport: z
    .object({
      width: z.number().int().positive().max(8192),
      height: z.number().int().positive().max(8192),
    })
    .refine((size) => size.width * size.height <= 16_777_216, "viewport exceeds 16 megapixels"),
  camera: cameraSchema,
  window: windowSchema,
  labelsEnabled: z.boolean(),
  /** Every structure selected for display, including hidden ones; ids belong to the revision. */
  structures: z
    .array(z.object({ structureId: id, visible: z.boolean(), opacity: percent }))
    .max(4096)
    .refine((items) => new Set(items.map((s) => s.structureId)).size === items.length, {
      message: "duplicate structure",
    }),
  /** Resolved focus preserves the highlighted mask/box/point, not a command to jump again. */
  focus: focusSchema.optional(),
};

export const reviewSnapshotViewStateSchema = z.discriminatedUnion("kind", [
  z.object({ ...view, kind: z.literal("acquired"), sliceIndex: z.number().int().nonnegative() }),
  z.object({
    ...view,
    kind: z.literal("volume3d"),
    /** The raw-intensity rendering controls, not segmented-surface properties. */
    threshold: percent,
    opacity: percent,
  }),
]);
export type ReviewSnapshotViewState = z.infer<typeof reviewSnapshotViewStateSchema>;

export const createReviewSnapshotRequestSchema = z.object({
  id: z.uuid(),
  revisionId: id,
  taskId: taskIdSchema,
  viewState: reviewSnapshotViewStateSchema,
  pngBase64: z
    .string()
    .min(1)
    .max(4 * Math.ceil(MAX_REVIEW_SNAPSHOT_BYTES / 3))
    .regex(/^[A-Za-z0-9+/]+={0,2}$/)
    .refine((value) => value.length % 4 === 0, "base64 length must be a multiple of four"),
});
export type CreateReviewSnapshotRequest = z.infer<typeof createReviewSnapshotRequestSchema>;

export const reviewSnapshotSchema = z.object({
  id: z.uuid(),
  runId: runIdSchema,
  revisionId: id,
  taskId: taskIdSchema,
  by: userIdSchema,
  createdAt: z.iso.datetime(),
  viewState: reviewSnapshotViewStateSchema,
  png: z.object({
    sha256: sha256Schema,
    byteLength: z.number().int().positive().max(MAX_REVIEW_SNAPSHOT_BYTES),
  }),
});
export type ReviewSnapshot = z.infer<typeof reviewSnapshotSchema>;

export const listReviewSnapshotsResponseSchema = z.object({
  snapshots: z.array(reviewSnapshotSchema),
});
