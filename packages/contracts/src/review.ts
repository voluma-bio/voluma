/**
 * The review data the Review lane renders for one run: the scan's grid,
 * revisions of the run, and per revision the tasks with their measurements,
 * checks and evidence, the segmented structures with mesh files, and the
 * bones' anatomical frames. Display-only state (labels for buttons, signed
 * URLs, visibility, opacity, colours) is not here; the UI derives it.
 *
 * Shaped so both the Review UI's presentation model and the reference run's
 * `web-review/manifest.json` (microct-analysis, `review-site/export.py`) can be
 * expressed in it. The importer from that manifest lives in the Review lane.
 *
 * Coordinates: `zyx` triples are voxel indices in array order; `xyz` are
 * voxel-centre indices in X,Y,Z order on the original grid; `sceneMm` is
 * millimetres relative to `grid.centerWorldMm` (the viewer's origin); `uvw` are
 * voxel indices in a bone's aligned grid (`frames`). Paths are relative to the
 * run's output root (`r2.ts`).
 */
import { z } from "zod";
import { workflowPinSchema } from "./r2";

const vec3 = z.tuple([z.number(), z.number(), z.number()]);
const pair = z.tuple([vec3, vec3]);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);

export const gridSchema = z.object({
  /** Identifies the voxel grid every `zyx`/`xyz` coordinate refers to. */
  gridId: sha256,
  /** 4x4 row-major: voxel XYZ to world mm. */
  affine: z.tuple([
    z.tuple([z.number(), z.number(), z.number(), z.number()]),
    z.tuple([z.number(), z.number(), z.number(), z.number()]),
    z.tuple([z.number(), z.number(), z.number(), z.number()]),
    z.tuple([z.number(), z.number(), z.number(), z.number()]),
  ]),
  centerWorldMm: vec3,
  shapeZyx: vec3,
});
export type Grid = z.infer<typeof gridSchema>;

/** A file that backs a number or is offered for download: a figure, script or report. */
export const assetSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Pipeline stage that produced it. */
  stage: z.string(),
  path: z.string(),
  sha256,
});
export type Asset = z.infer<typeof assetSchema>;

/**
 * Surface mesh in a binary file: `vertices` float32 xyz positions (scene mm,
 * little-endian), then `indices` uint32 triangle corners (little-endian).
 */
export const meshSchema = z.object({
  path: z.string(),
  vertices: z.number().int().nonnegative(),
  indices: z.number().int().nonnegative(),
  sha256,
});

export const structureSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Whether the workflow declared this structure; false for extra masks. */
  declared: z.boolean(),
  status: z.enum(["done", "provisional", "missing"]),
  /** Why it has this status. */
  reason: z.string(),
  /** Value in the segmentation volume. */
  label: z.number().int().positive().optional(),
  definition: z.string().optional(),
  volumeMm3: z.number().optional(),
  /** Seed voxels (Z,Y,X) it was grown from. */
  seedPointsZyx: z.array(vec3).optional(),
  /** Absent when `status` is `missing`. */
  mesh: meshSchema.optional(),
});
export type Structure = z.infer<typeof structureSchema>;

export const measurementSchema = z.object({
  id: z.string(),
  title: z.string().optional(),
  /** Null means not supplied; never zero. */
  value: z.number().finite().nullable(),
  /** `mm`, `mm^3`, `1/mm`, or `1` for a dimensionless ratio. */
  unit: z.string(),
  confidence: z.enum(["provisional", "candidate"]),
  /** The producer's own status wording, e.g. "Provisional: boundary/ROI review required". */
  note: z.string().optional(),
  definition: z.string().optional(),
  /** `Asset.id`s in the task's `evidence` that show this number. */
  evidenceIds: z.array(z.string()),
  /** Values other readers got for the same quantity. */
  references: z.array(z.object({ reader: z.string(), value: z.number() })),
  /** Structures it was counted from or drawn on. */
  structureIds: z.array(z.string()).optional(),
  bone: z.string().optional(),
  /** Ratios: ids of the measurements divided. */
  numeratorId: z.string().optional(),
  denominatorId: z.string().optional(),
  /** Distances: the two endpoints. */
  points: z.object({ xyz: pair, sceneMm: pair, alignedUvw: pair.optional() }).optional(),
  distanceMethod: z.string().optional(),
  /** Method-specific extras (e.g. a plate-thickness patch and its statistics). */
  details: z.record(z.string(), z.json()).optional(),
});
export type Measurement = z.infer<typeof measurementSchema>;

export const taskSchema = z.object({
  id: z.string(),
  title: z.string(),
  /** What the task asked of the agent. */
  ask: z.string(),
  dependsOn: z.array(z.string()),
  structureIds: z.array(z.string()),
  /** Unchanged tasks keep this id across revisions. */
  resultRevisionId: z.string(),
  checker: z.object({ verdict: z.enum(["passed", "needs-review"]), text: z.string() }),
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

/**
 * A bone's anatomical frame, fitted along its shaft. Bases and origins are in
 * original-grid voxel XYZ. The aligned-grid fields exist only for bones
 * resampled into an aligned grid (the tibia).
 */
export const boneFrameSchema = z.object({
  /** Columns are the frame's U, V, W axes. */
  basisColumnsXyz: z.tuple([vec3, vec3, vec3]),
  originXyz: vec3,
  shaftCentersXyz: z.array(vec3),
  shaftZRange: z.tuple([z.number(), z.number()]),
  epiphysisZRange: z.tuple([z.number(), z.number()]),
  method: z.string(),
  alignedShapeZyx: vec3.optional(),
  localLowerUvw: vec3.optional(),
  alignedToOriginalMatrix: z.tuple([vec3, vec3, vec3]).optional(),
  alignedToOriginalOffset: vec3.optional(),
});
export type BoneFrame = z.infer<typeof boneFrameSchema>;

export const revisionSchema = z.object({
  id: z.string(),
  label: z.string(),
  createdAt: z.iso.datetime(),
  tasks: z.array(taskSchema),
  structures: z.array(structureSchema),
  /** Keyed by bone name (`femur`, `tibia`). */
  frames: z.record(z.string(), boneFrameSchema),
});
export type Revision = z.infer<typeof revisionSchema>;

export const reviewRunSchema = z.object({
  id: z.string(),
  sample: z.string(),
  workflow: workflowPinSchema,
  grid: gridSchema,
  /** Oldest first; the last is the latest. */
  revisions: z.array(revisionSchema).min(1),
  /** The run's log of decisions and changes. */
  record: z.array(
    z.object({
      id: z.string(),
      revisionId: z.string(),
      taskId: z.string().nullable(),
      text: z.string(),
      at: z.iso.datetime(),
    }),
  ),
});
export type ReviewRun = z.infer<typeof reviewRunSchema>;

export const correctionRequestSchema = z.object({
  runId: z.string(),
  baseRevisionId: z.string(),
  taskId: z.string(),
  instruction: z.string().trim().min(1).max(2000),
});
export type CorrectionRequest = z.infer<typeof correctionRequestSchema>;

/** What a correction would redo; the reviewer confirms before anything runs. */
export const correctionProposalSchema = correctionRequestSchema.extend({
  id: z.string(),
  affectedTaskIds: z.array(z.string()),
});
export type CorrectionProposal = z.infer<typeof correctionProposalSchema>;
