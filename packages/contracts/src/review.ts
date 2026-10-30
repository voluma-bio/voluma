/**
 * A read model: the review data the API assembles from the thread store. It is not a
 * stored document, so a rerun rewrites no other task's data.
 * Served by `GET /api/review/runs/:runId` (`getReviewRun`): 404 when the caller
 * can't read the run, 409 when it has no plan (no `revision.started`: not started,
 * or ended before one). A run's files (every `evidenceKey`) are read through `GET /api/review/runs/:runId/files/:sha256`
 * (`reviewFileUrl`).
 *
 * Two layers, so a different workflow (vascular, materials) gets its own final
 * review with no new Review-lane code:
 *
 * - A generic core: the run, its revisions, and per revision the tasks with
 *   their measurements, scores, checks and evidence files.
 * - Building blocks on each revision, a closed set the shell knows how to
 *   render: `volumes`, `structures`, `surfaces` and `annotations`. A workflow
 *   fills them with what it has; it cannot invent a new kind. A kind the shell
 *   cannot draw is a small contract PR that adds a block, not a field on an old one.
 *   A measurement or score names the blocks it is shown with (`on`, `context`) by
 *   id; the links come from the workflow's declaration, not from the report.
 *
 * Coordinates: annotations are world mm (the fold maps the voxels an agent reports
 * through the grid's `affine`); the UI converts to voxels through the volume's
 * `affine`. Structures and surfaces are voxels on their grid. Every block on a grid
 * names that volume block as `volumeId`; `Volume.gridId` is only the producer's id.
 *
 * Converted assets (`ReviewRun.assets`) are one map for the run, keyed by the
 * sha256 of the file a block points at: absent means still preparing. Revisions
 * stay snapshots of the outputs; the map is of the whole log.
 *
 * Size: each revision repeats every block. That is fine for one revision; the
 * API may serve one revision at a time rather than the whole run.
 *
 * Files are stored as full R2 keys (`storedKeySchema`), always produced by an
 * `r2.ts` builder: `evidenceKey(runId, sha256)` for run files. Never a path relative
 * to some root. Converted review assets (`reviewAssetKey`) are not stored: the assets route builds
 * their keys from the manifest.
 *
 * Nullable fields are what the log may not say (no checker yet, a structure whose grid
 * isn't reported). Display-only state (button
 * labels, signed URLs, visibility, opacity, colours) is not here; the UI
 * derives it.
 */
import { z } from "zod";
import { userIdSchema } from "./auth";
import {
  modelRefSchema,
  outputKindSchema,
  runIdSchema,
  taskIdSchema,
  taskStatusSchema,
} from "./ids";
import {
  relativePathSchema,
  sha256Schema as sha256,
  storedKeySchema,
  storedPrefixSchema,
} from "./r2";
import { workflowPinSchema } from "./workflow";

/**
 * Review progress for the latest successfully completed results, shared by Run and
 * ReviewRun; null unless the current execution completed successfully.
 * A correction invalidates review completion;
 * only unchanged task results retain acceptance. Count the latest results' open checks,
 * never historical revisions. Accepting the last check leaves reviewedAt null: only an
 * explicit Mark reviewed sets it, and only with no open checks.
 */
export const reviewSummarySchema = z
  .object({
    revisionId: z.string().min(1),
    remainingToCheck: z.number().int().nonnegative(),
    reviewedAt: z.iso.datetime().nullable(),
  })
  .refine((r) => r.reviewedAt === null || r.remainingToCheck === 0, {
    path: ["reviewedAt"],
    message: "reviewed results cannot have open checks",
  });
export type ReviewSummary = z.infer<typeof reviewSummarySchema>;

/**
 * Cookie-authenticated review commands, returning 200 reviewDecisionResponseSchema.
 *   POST /api/review/runs/:runId/checks/:checkId/accept
 *     body acceptCheckRequestSchema (runId and checkId are URL parameters)
 *   POST /api/review/runs/:runId/mark-reviewed
 *     body markReviewedRequestSchema
 *
 * Both require the latest successfully completed result. 400: invalid request;
 * 404: unknown/unreadable run or unknown task/check; 403: read-only example;
 * 409: obsolete baseRevisionId, no current completed result, or Mark reviewed with
 * open checks. Authentication and Origin rules are the same as run.ts. Readable
 * non-example runs have shared review state: authorized readers can review them,
 * including guests reviewing their own runs, not one review state per researcher.
 *
 * Accept is idempotent for the same check on the same task result; a duplicate changes
 * no count and appends no second decision. Mark reviewed is also idempotent for the
 * same completed revision, preserving its original actor and time. Stale revisions
 * still conflict on a retry. Neither command changes results, confidence, execution
 * or task status. Zero checks alone never means Reviewed; viewing/exporting does not
 * mark a run reviewed. Current-result validation, deduplication, decision append and
 * summary update are one serialized transaction against correction writes. A failure
 * persists neither decision nor summary. Use the response/refetch for UI updates:
 * the existing run SSE connection closes when execution ends.
 */
export const acceptCheckRequestSchema = z.object({
  baseRevisionId: z.string().min(1),
  taskId: taskIdSchema,
});
export type AcceptCheckRequest = z.infer<typeof acceptCheckRequestSchema>;

export const markReviewedRequestSchema = z.object({
  baseRevisionId: z.string().min(1),
});
export type MarkReviewedRequest = z.infer<typeof markReviewedRequestSchema>;

/**
 * Server-authored decisions in the run log, ignored by the scientific fold. Their
 * envelope's threadId is `<runId>.reviewer`, a record of human actions, not a model
 * thread (no thread.started or Pi history). The API supplies by and createdAt from
 * the authenticated caller and its clock; runner ingest rejects these event types.
 * Server writes share the run log's seq allocation, without a runner lease.
 * Decisions and the summary commit atomically. The summary is a projection of these
 * decisions over the latest folded checks, not a second independently editable count.
 */
export const checkAcceptedSchema = z.object({
  by: userIdSchema,
  /** The request's baseRevisionId, verified as the latest completed revision. */
  revisionId: z.string().min(1),
  taskId: taskIdSchema,
  checkId: z.string().min(1),
  /**
   * The named task's resultRevisionId at acceptance. Carry acceptance forward only
   * while that result and check identity are unchanged; a rerun must not reuse an
   * acceptance merely because its check id survived. Keep earlier results and decisions.
   */
  resultRevisionId: z.string().min(1),
});

/** Only explicit Mark reviewed writes this event; acceptance never does. */
export const reviewCompletedSchema = z.object({
  by: userIdSchema,
  revisionId: z.string().min(1),
});

/** A position or direction in world mm. */
const vec3 = z.tuple([z.number(), z.number(), z.number()]);
const row4 = z.tuple([z.number(), z.number(), z.number(), z.number()]);
type R4 = z.infer<typeof row4>;

/** A grid's shape `[z, y, x]`. */
export const shapeZyxSchema = z.tuple([
  z.number().int().positive(),
  z.number().int().positive(),
  z.number().int().positive(),
]);

/** A voxel index `[z, y, x]` of a grid. */
export const voxelIndexSchema = z.tuple([z.int().min(0), z.int().min(0), z.int().min(0)]);

/** An inclusive box in voxel indices `[z, y, x]`; `min` must not exceed `max` on any axis. */
export const voxelBoxSchema = z
  .object({ min: voxelIndexSchema, max: voxelIndexSchema })
  .refine((b) => b.min.every((lo, i) => lo <= (b.max[i] ?? lo)), {
    message: "box.min must not exceed box.max on any axis",
  });

/**
 * What the converter (`workflows/core/convert/review_assets.py`) prints and writes as
 * `manifest.json`; the runner parses it and builds `assets.ready` from it. Paths are relative
 * to the asset prefix (`reviewAssetKey` in `r2.ts`). It carries no `sourceSha256`: the runner knows which
 * file it converted, and identity is never taken from subprocess output. Other keys in the
 * printed JSON are ignored.
 */
export const reviewAssetsManifestSchema = z.object({
  /** OME-Zarr levels, finest first; `scaleZyx` is source voxels per level voxel on each axis. */
  levels: z.array(
    z.object({ path: relativePathSchema, shapeZyx: shapeZyxSchema, scaleZyx: shapeZyxSchema }),
  ),
  /**
   * Surface meshes: float32 vertices (x, y, z) in voxels of the source grid at full resolution,
   * then uint32 triangle indices, little-endian. `label` is set for a labels volume's mesh.
   */
  meshes: z.array(
    z.object({
      label: z.number().int().positive().optional(),
      path: relativePathSchema,
      vertices: z.number().int().nonnegative(),
      indices: z
        .number()
        .int()
        .nonnegative()
        .refine((n) => n % 3 === 0, "indices come in triangles"),
    }),
  ),
});
export type ReviewAssetsManifest = z.infer<typeof reviewAssetsManifestSchema>;

/** The converted assets of one reported file, or why there are none. */
export const reviewAssetsSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("ready"), ...reviewAssetsManifestSchema.shape }),
  z.object({ state: z.literal("failed"), error: z.string().min(1) }),
]);
export type ReviewAssets = z.infer<typeof reviewAssetsSchema>;

/** Voxel types the viewer loads: intensities for `image` volumes, label values for `labels` volumes. */
export const imageDtype = z.enum(["int16", "uint16", "float32"]);
export const labelDtype = z.enum(["uint8", "uint16"]);

/** Every voxel type an `.npy` volume may hold. */
export const npyDtypeSchema = z.enum([...imageDtype.options, ...labelDtype.options]);

/** Where a volume's voxels are stored, in a format the viewer loads. */
export const volumeDataSchema = z.discriminatedUnion("format", [
  /**
   * A DICOM series: the `.dcm` files under `prefix`, the series with this UID.
   * The volume's `affine` and `shapeZyx` must equal the series' header geometry
   * (the viewer takes world space from the headers and ignores our copy).
   */
  z.object({ format: z.literal("dicom"), prefix: storedPrefixSchema, seriesId: z.string() }),
  /**
   * An `.npy` array in C order, shaped `shapeZyx`, of type `dtype`: `image`
   * volumes `int16 | uint16 | float32`, `labels` volumes `uint8 | uint16`.
   * Producers convert other numpy types (int32, bool) on upload.
   */
  z.object({
    format: z.literal("npy"),
    key: storedKeySchema,
    sha256,
    dtype: npyDtypeSchema,
  }),
]);

/** Orthogonal, nonzero columns in the 3x3 part and a bottom row of 0,0,0,1. */
function isSpacedRigid(m: [R4, R4, R4, R4]): boolean {
  const col = (j: 0 | 1 | 2) => [m[0][j], m[1][j], m[2][j]] as const;
  const dot = (a: readonly [number, number, number], b: readonly [number, number, number]) =>
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const [c0, c1, c2] = [col(0), col(1), col(2)];
  const near0 = (a: readonly [number, number, number], b: readonly [number, number, number]) =>
    Math.abs(dot(a, b)) <= 1e-4 * Math.sqrt(dot(a, a) * dot(b, b));
  return (
    dot(c0, c0) > 0 &&
    dot(c1, c1) > 0 &&
    dot(c2, c2) > 0 &&
    near0(c0, c1) &&
    near0(c0, c2) &&
    near0(c1, c2) &&
    m[3].join() === "0,0,0,1"
  );
}

/**
 * A voxel grid the viewer slices: the scan, a derived volume (an aligned
 * grid), or a label map. Several volumes can share one affine.
 */
export const volumeSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** `image` shows intensities; `labels` holds the label values of `Structure.voxels`. */
  kind: z.enum(["image", "labels"]),
  shapeZyx: shapeZyxSchema,
  /**
   * 4x4 row-major: voxel index (x,y,z) to world mm. The 3x3 part has
   * orthogonal columns (their lengths are the positive voxel spacings).
   */
  affine: z
    .tuple([row4, row4, row4, row4])
    .refine(isSpacedRigid, "affine needs orthogonal, nonzero columns and a bottom row of 0,0,0,1"),
  /** What the values are: `"HU"`, `"mm"`; null for raw or unitless. */
  unit: z.string().nullable(),
  /**
   * The grid id the producer wrote beside the array (the `.npy` sidecar's `grid_id`). A
   * structure mask, surface or annotation reports the id of the grid it was made on, and
   * is refused when it differs: frames share spacing, so a wrong grid's voxels would pass.
   * Blocks on this volume name it by its block `id`, as `volumeId`; `gridId` means only this.
   */
  gridId: z.string().min(1),
  /** Null when the producer ships the volume in no loadable format. */
  data: volumeDataSchema.nullable(),
});
export type Volume = z.infer<typeof volumeSchema>;

/** A segmented object: a label in a `labels` volume, or a cropped mask on a grid. */
export const structureSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    /** The volume it sits on; null when that volume isn't reported. */
    volumeId: z.string().nullable(),
    /**
     * Where its voxels are: a value in the `labels` volume; or a uint8 mask cropped to its
     * bounding box, placed on the volume at `offsetZyx` (its levels and mesh are in crop voxels:
     * add the offset). Null when the structure is reported missing or its volume isn't reported.
     */
    voxels: z
      .union([
        z.object({ label: z.number().int().positive() }),
        z.object({
          mask: z.object({ key: storedKeySchema, sha256, shapeZyx: shapeZyxSchema }),
          offsetZyx: voxelIndexSchema,
        }),
      ])
      .nullable(),
    /** Set when the task reported the structure as missing (not in the field of view): why. */
    missing: z.object({ reason: z.string().min(1) }).nullable(),
    definition: z.string().optional(),
    volumeMm3: z.number().optional(),
  })
  .refine((s) => s.voxels === null || s.volumeId !== null, {
    path: ["volumeId"],
    message: "a structure with voxels names its volume",
  });
export type Structure = z.infer<typeof structureSchema>;

/** A traced face as a height field on a grid, drawn as a line in the slices and a mesh in 3D. */
export const surfaceSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** The volume it is a height field on. */
  volumeId: z.string(),
  /** The array axis the heights are measured along. */
  axis: z.literal([0, 1, 2]),
  /** float32, the grid's shape without `axis`; NaN where the surface leaves the bone. */
  heights: z.object({ key: storedKeySchema, sha256 }),
});
export type Surface = z.infer<typeof surfaceSchema>;

const annotationBase = {
  id: z.string(),
  name: z.string(),
  /** The volume it was placed on (the one whose slices show it first). */
  volumeId: z.string(),
  /** The producer's own description, e.g. how a landmark was placed. */
  note: z.string().optional(),
};

/** A landmark. */
export const pointAnnotationSchema = z.object({
  ...annotationBase,
  kind: z.literal("point"),
  position: vec3,
});
/** A ruler between two endpoints, or an axis. */
export const lineAnnotationSchema = z.object({
  ...annotationBase,
  kind: z.literal("line"),
  a: vec3,
  b: vec3,
});

/**
 * Something drawn in the views. Positions are world mm. The shell renders
 * every kind; a workflow chooses which to supply. A region of interest is a
 * structure, not an annotation. Next kinds (`plane`, `region`, `path`) are in
 * `.context/TODO.md`.
 */
export const annotationSchema = z.discriminatedUnion("kind", [
  pointAnnotationSchema,
  lineAnnotationSchema,
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
  /** Set for a file the workflow declared a media type for; absent for evidence. */
  mediaType: z.string().optional(),
});
export type Asset = z.infer<typeof assetSchema>;

// ── Generic core ─────────────────────────────────────────────────────────────

export const measurementSchema = z.object({
  id: z.string(),
  title: z.string().optional(),
  /** Null means not supplied; never zero. */
  value: z.number().finite().nullable(),
  /** Examples: `mm`, `mm^3`, `1/mm`, `mg HA/cm^3`; `1` for a dimensionless ratio or a count. */
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
  /** Blocks (volume, structure, surface, annotation ids) it was measured on: highlighted with the value. From the declaration. */
  on: z.array(z.string()),
  /** Blocks drawn around it. From the declaration. */
  context: z.array(z.string()),
  /** Ratios: ids of the measurements divided. */
  numeratorId: z.string().optional(),
  denominatorId: z.string().optional(),
  /** The thread event that reported it. */
  source: z.object({ threadId: z.string().min(1), eventId: z.string().min(1) }).nullable(),
});
export type Measurement = z.infer<typeof measurementSchema>;

/** A level on a scale: an OARSI grade, a yes/no, a QC pass. Same producer-given fields as a measurement. */
export const scoreSchema = z.object({
  id: z.string(),
  title: z.string().optional(),
  level: z.string().min(1),
  /** The levels the workflow declared, lowest first; null when it declared none. */
  scale: z.array(z.string().min(1)).nullable(),
  confidence: measurementSchema.shape.confidence,
  note: z.string().optional(),
  definition: z.string().optional(),
  evidenceIds: z.array(z.string()),
  /** What was graded: the medial plateau, the lesion a QC fail is about. */
  on: measurementSchema.shape.on,
  context: measurementSchema.shape.context,
  source: measurementSchema.shape.source,
});
export type Score = z.infer<typeof scoreSchema>;

/**
 * What a To check item points at, so the review can outline it. Absent on an
 * item means the whole task. `on` names blocks of any kind (volume, structure,
 * surface, annotation) to outline. All coordinates are voxel indices on the scan's
 * grid, in [z, y, x] order, never world mm. `volumeId` is a labels volume (a
 * disagreement mask); `label` picks one region in it, so it needs `volumeId`.
 * `box` is inclusive; `point` is where the crosshair centres.
 */
export const focusSchema = z
  .object({
    on: z.array(z.string()),
    volumeId: z.string().optional(),
    label: z.int().min(1).optional(),
    box: voxelBoxSchema.optional(),
    point: voxelIndexSchema.optional(),
  })
  .refine((f) => f.label === undefined || f.volumeId !== undefined, {
    path: ["label"],
    message: "label needs volumeId",
  });
export type Focus = z.infer<typeof focusSchema>;

export const taskSchema = z.object({
  /** The r2 task segment (`outputKey`). */
  id: taskIdSchema,
  title: z.string(),
  /** What the task asked of the agent. */
  ask: z.string(),
  dependsOn: z.array(z.string()),
  /** The task's status in this revision: its status at that point in the log (`fold.ts`) */
  status: taskStatusSchema,
  /** The revision in which the task last changed; unchanged tasks keep this id across revisions. */
  resultRevisionId: z.string(),
  /** Null when no second agent checked it. */
  checker: z.object({ verdict: z.enum(["passed", "needs-review"]), text: z.string() }).nullable(),
  /** Threads in the run record: what the agent did, and its check. */
  threads: z.object({
    worker: z.string().min(1).nullable(),
    check: z.string().min(1).nullable(),
  }),
  /** The model each thread called, `provider/id`; null where the thread is null or its start recorded none. */
  models: z.object({
    worker: modelRefSchema.nullable(),
    check: modelRefSchema.nullable(),
  }),
  measurements: z.array(measurementSchema),
  scores: z.array(scoreSchema),
  /** Outputs the workflow declared for this task and the attempt hasn't reported. Required ones keep the task from `done`. */
  missing: z.array(
    z.object({
      outputId: z.string(),
      kind: outputKindSchema,
      required: z.boolean(),
      /** Why, when the attempt reported it missing or the task was skipped; absent when it simply wasn't reported. */
      reason: z.string().optional(),
    }),
  ),
  /** Ids (`taskId/outputId`, as in the blocks) of the outputs the workflow didn't declare. */
  undeclared: z.array(z.string()),
  checks: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      detail: z.string(),
      status: z.enum(["open", "accepted"]),
      focus: focusSchema.optional(),
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
  surfaces: z.array(surfaceSchema),
  annotations: z.array(annotationSchema),
});
export type Revision = z.infer<typeof revisionSchema>;

export const reviewRunSchema = z.object({
  id: runIdSchema,
  sample: z.string(),
  workflows: z.array(workflowPinSchema).min(1),
  /** Oldest first; the last is the latest. */
  revisions: z.array(revisionSchema).min(1),
  /** Converted assets by the sha256 of the file they were made from; absent: still preparing. */
  assets: z.record(sha256, reviewAssetsSchema),
  review: reviewSummarySchema.nullable(),
});
export type ReviewRun = z.infer<typeof reviewRunSchema>;

/** Commands require successfully completed results, so their summary is non-null. */
export const reviewDecisionResponseSchema = reviewRunSchema.extend({
  review: reviewSummarySchema,
});
export type ReviewDecisionResponse = z.infer<typeof reviewDecisionResponseSchema>;
