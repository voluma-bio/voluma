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
 * A screenshot is one pane of the grid viewer (a slice plane or 3D) on the task's analysis
 * grid. Restore only after opening the pinned revision/task on the saved `gridId`; apply the
 * crosshair, contrast and the pane's view after the grid loads, and never let the restored
 * focus move the saved crosshair again. The PNG is the original capture even if later
 * display tokens/rendering change. Export bundles keep this record and PNG under its id;
 * {snapshot:id} resolves only within the exported run/revision.
 *
 * `acquired` screenshots were taken in the earlier DICOM viewer (#241). They stay listed and
 * exported but can't be reopened, and the server no longer accepts them.
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

const viewport = z
  .object({
    width: z.number().int().positive().max(8192),
    height: z.number().int().positive().max(8192),
  })
  .refine((size) => size.width * size.height <= 16_777_216, "viewport exceeds 16 megapixels");

const structuresSchema = z
  .array(z.object({ structureId: id, visible: z.boolean(), opacity: percent }))
  .max(4096)
  .refine((items) => new Set(items.map((s) => s.structureId)).size === items.length, {
    message: "duplicate structure",
  });

const voxel = z.number().int().nonnegative();

/** What every grid pane saves: the grid, its crosshair, contrast and structure display. */
const grid = {
  version: z.literal(2),
  /** The task's analysis grid (`Volume.gridId`); restore refuses another grid. */
  gridId: id,
  /** Physical PNG pixels, including device pixel ratio. Maximum 16 megapixels. */
  viewport,
  /** The crosshair, in source voxels (z, y, x) of the grid. */
  point: z.tuple([voxel, voxel, voxel]),
  /** The image's display window, in its stored values. */
  window: windowSchema,
  /** Structures and surfaces whose display was changed; any other is shown at full opacity. */
  structures: structuresSchema,
  /** Resolved focus preserves the highlighted blocks, not a command to jump again. */
  focus: focusSchema.optional(),
};

/** A view in the earlier DICOM viewer (#241): listed and exported, never reopened. */
const acquiredSchema = z.object({
  version: z.literal(1),
  kind: z.literal("acquired"),
  seriesId: id,
  scanGeometrySha256: sha256Schema,
  viewport,
  camera: cameraSchema,
  window: windowSchema,
  labelsEnabled: z.boolean(),
  structures: structuresSchema,
  focus: focusSchema.optional(),
  sliceIndex: z.number().int().nonnegative(),
});

export const reviewSnapshotViewStateSchema = z.discriminatedUnion("kind", [
  acquiredSchema,
  z.object({
    ...grid,
    kind: z.literal("slice"),
    plane: z.enum(["axial", "coronal", "sagittal"]),
    /** Pixels per mm as a multiple of the zoom that fits the grid in the pane. */
    zoom: z.number().positive(),
    /** The pane centre in pane mm: columns right, rows down as negative y. */
    center: z.tuple([z.number(), z.number()]),
  }),
  z.object({
    ...grid,
    kind: z.literal("3d"),
    /** In the grid's own mm (voxel × spacing, x y z). */
    camera: z
      .object({ position: vec3, target: vec3, up: vec3 })
      .refine(
        (c) => c.position.some((v, i) => v !== c.target[i]) && c.up.some((v) => v !== 0),
        "camera needs distinct position and target and a nonzero up vector",
      ),
  }),
]);
export type ReviewSnapshotViewState = z.infer<typeof reviewSnapshotViewStateSchema>;
/** A screenshot the grid viewer can take and reopen. */
export type GridViewState = Exclude<ReviewSnapshotViewState, { kind: "acquired" }>;

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
