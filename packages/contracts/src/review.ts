/**
 * A read model: the review data the API assembles from the thread store (and,
 * for the reference run, the importer builds from its manifest). It is not a
 * stored document, so a rerun rewrites no other task's data.
 *
 * Two layers, so a different workflow (vascular, materials) gets its own final
 * review with no new Review-lane code:
 *
 * - A generic core: the run, its revisions, and per revision the tasks with
 *   their measurements, checks and evidence files.
 * - Building blocks on each revision, a closed set the shell knows how to
 *   render: `volumes`, `structures` and `annotations`. A workflow fills them
 *   with what it has; it cannot invent a new kind. A kind the shell cannot
 *   draw is a small contract PR that adds a block, not a field on an old one.
 *
 * Coordinates: every position is world mm (the volume affines' output). The UI
 * converts to voxels through the volume's `affine`. The one exception is mesh
 * vertices, whose binary files are centred on `mesh.centerWorldMm`.
 *
 * Files are stored as full R2 keys (`storedKeySchema`), always produced by an
 * `r2.ts` builder: `evidenceKey(runId, sha256)` for run files, and a key under
 * `reference/OA6-1RK/run/` for the reference run. Never a path relative to some
 * root.
 *
 * Nullable fields are what a producer may not know (the reference manifest has
 * no tasks, checker, structure status or measurement-to-evidence links); the
 * importer leaves them null rather than guessing. Display-only state (button
 * labels, signed URLs, visibility, opacity, colours) is not here; the UI
 * derives it.
 */
import { z } from "zod";
import {
  runIdSchema,
  sha256Schema as sha256,
  storedKeySchema,
  storedPrefixSchema,
  taskIdSchema,
} from "./r2";
import { workflowPinSchema } from "./workflow";

/** A position or direction in world mm. */
const vec3 = z.tuple([z.number(), z.number(), z.number()]);
const row4 = z.tuple([z.number(), z.number(), z.number(), z.number()]);

// ── Building blocks ──────────────────────────────────────────────────────────

/** Where a volume's voxels are stored, in a format the viewer loads. */
export const volumeDataSchema = z.discriminatedUnion("format", [
  /** A DICOM series: the `.dcm` files under `prefix`, the series with this UID. */
  z.object({ format: z.literal("dicom"), prefix: storedPrefixSchema, seriesId: z.string() }),
  /** An `.npy` array in C order, shaped `shapeZyx`. The header carries the dtype. */
  z.object({ format: z.literal("npy"), key: storedKeySchema, sha256 }),
]);

/**
 * A voxel grid the viewer slices: the scan, a derived volume (an aligned
 * grid), or a label map. Several volumes can share one affine.
 */
export const volumeSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** `image` shows intensities; `labels` holds `Structure.label` values. */
  kind: z.enum(["image", "labels"]),
  shapeZyx: z.tuple([
    z.number().int().positive(),
    z.number().int().positive(),
    z.number().int().positive(),
  ]),
  /** 4x4 row-major: voxel index (x,y,z) to world mm. */
  affine: z.tuple([row4, row4, row4, row4]),
  /** Null when the producer ships the volume in no loadable format. */
  data: volumeDataSchema.nullable(),
});
export type Volume = z.infer<typeof volumeSchema>;

/**
 * Surface mesh in a binary file: `vertices` float32 xyz positions (mm,
 * relative to `centerWorldMm`, little-endian), then `indices` uint32 triangle
 * corners (little-endian). World position = vertex + `centerWorldMm`.
 */
export const meshSchema = z.object({
  key: storedKeySchema,
  vertices: z.number().int().nonnegative(),
  indices: z.number().int().nonnegative(),
  sha256,
  centerWorldMm: vec3,
});

/** A segmented object: a label in a `labels` volume, usually with a surface. */
export const structureSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** The `labels` volume it lives in. */
  volumeId: z.string(),
  /** Value in that volume. */
  label: z.number().int().positive().optional(),
  /** Whether the workflow declared this structure; null when the producer doesn't say. */
  declared: z.boolean().nullable(),
  /** Null when the producer doesn't say. */
  status: z.enum(["done", "provisional", "missing"]).nullable(),
  /** Why it has this status. */
  reason: z.string().nullable(),
  definition: z.string().optional(),
  volumeMm3: z.number().optional(),
  /** Absent when `status` is `missing`. */
  mesh: meshSchema.optional(),
});
export type Structure = z.infer<typeof structureSchema>;

const annotationBase = {
  id: z.string(),
  name: z.string(),
  /** The volume it was placed on (the one whose slices show it first). */
  volumeId: z.string(),
  /** Measurements it illustrates; the measurement's `annotationIds` is the same link from the other side. */
  measurementIds: z.array(z.string()),
  /** The producer's own description, e.g. how a frame axis was fitted. */
  note: z.string().optional(),
};

/**
 * Something drawn in the views. Positions are world mm. The shell renders
 * every kind; a workflow chooses which to supply.
 */
export const annotationSchema = z.discriminatedUnion("kind", [
  /** A landmark. */
  z.object({ ...annotationBase, kind: z.literal("point"), position: vec3 }),
  /** A ruler between two endpoints, or an axis. */
  z.object({ ...annotationBase, kind: z.literal("line"), a: vec3, b: vec3 }),
  /** An infinite plane through `origin`; `normal` is a unit vector. */
  z.object({ ...annotationBase, kind: z.literal("plane"), origin: vec3, normal: vec3 }),
  /** A box (possibly rotated): `corner` plus three edge vectors. */
  z.object({
    ...annotationBase,
    kind: z.literal("region"),
    corner: vec3,
    edges: z.tuple([vec3, vec3, vec3]),
  }),
]);
export type Annotation = z.infer<typeof annotationSchema>;

/** A file that backs a number or is offered for download: a figure, script or report. */
export const assetSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Pipeline stage that produced it. */
  stage: z.string(),
  key: storedKeySchema,
  sha256,
});
export type Asset = z.infer<typeof assetSchema>;

// ── Generic core ─────────────────────────────────────────────────────────────

export const measurementSchema = z.object({
  id: z.string(),
  title: z.string().optional(),
  /** Null means not supplied; never zero. */
  value: z.number().finite().nullable(),
  /** `mm`, `mm^3`, `1/mm`, or `1` for a dimensionless ratio or a count. */
  unit: z.string(),
  /** Null when the producer gave no status. */
  confidence: z.enum(["provisional", "candidate"]).nullable(),
  /** The producer's own status wording, e.g. "Provisional: boundary/ROI review required". */
  note: z.string().optional(),
  definition: z.string().optional(),
  /** `Asset.id`s in the task's `evidence` that show this number. Empty when the producer gave no link; never filled by guessing. */
  evidenceIds: z.array(z.string()),
  /** Values other readers got for the same quantity. */
  references: z.array(z.object({ reader: z.string(), value: z.number() })),
  /** Structures it was counted from or drawn on. */
  structureIds: z.array(z.string()),
  /** Annotations that show it: the ruler of a distance, the region a statistic covers. */
  annotationIds: z.array(z.string()),
  /** Ratios: ids of the measurements divided. */
  numeratorId: z.string().optional(),
  denominatorId: z.string().optional(),
  /** The thread event that reported it. Null from the importer; set once `report_value` lands. */
  source: z.object({ threadId: z.string().min(1), eventId: z.string().min(1) }).nullable(),
});
export type Measurement = z.infer<typeof measurementSchema>;

export const taskSchema = z.object({
  /** The r2 task segment (`outputKey`). */
  id: taskIdSchema,
  title: z.string(),
  /** What the task asked of the agent. */
  ask: z.string(),
  dependsOn: z.array(z.string()),
  /** Structures the task uses; the Structures panel lists these. */
  structureIds: z.array(z.string()),
  /** Unchanged tasks keep this id across revisions. */
  resultRevisionId: z.string(),
  /** Null when no second agent checked it. */
  checker: z.object({ verdict: z.enum(["passed", "needs-review"]), text: z.string() }).nullable(),
  /** Threads in the run record: what the agent did, its check, the reviewer's chat. Null where the producer has none (the reference importer). */
  threads: z.object({
    worker: z.string().min(1).nullable(),
    check: z.string().min(1).nullable(),
    chat: z.string().min(1).nullable(),
  }),
  measurements: z.array(measurementSchema),
  checks: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      detail: z.string(),
      status: z.enum(["open", "accepted"]),
    }),
  ),
  evidence: z.array(assetSchema),
  files: z.array(assetSchema),
});
export type ReviewTask = z.infer<typeof taskSchema>;

export const revisionSchema = z.object({
  id: z.string(),
  label: z.string(),
  createdAt: z.iso.datetime(),
  tasks: z.array(taskSchema),
  volumes: z.array(volumeSchema),
  structures: z.array(structureSchema),
  annotations: z.array(annotationSchema),
});
export type Revision = z.infer<typeof revisionSchema>;

export const reviewRunSchema = z.object({
  id: runIdSchema,
  sample: z.string(),
  workflows: z.array(workflowPinSchema).min(1),
  /** Oldest first; the last is the latest. */
  revisions: z.array(revisionSchema).min(1),
});
export type ReviewRun = z.infer<typeof reviewRunSchema>;
