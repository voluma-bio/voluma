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
 * Size: each revision repeats every block. That is fine for one revision; the
 * API may serve one revision at a time rather than the whole run.
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
import { taskStatusSchema } from "./events";
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
type R4 = z.infer<typeof row4>;

// ── Building blocks ──────────────────────────────────────────────────────────

/** Voxel types the viewer loads: intensities for `image` volumes, label values for `labels` volumes. */
const imageDtype = z.enum(["int16", "uint16", "float32"]);
const labelDtype = z.enum(["uint8", "uint16"]);

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
    dtype: z.enum([...imageDtype.options, ...labelDtype.options]),
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
  /** `image` shows intensities; `labels` holds `Structure.label` values. */
  kind: z.enum(["image", "labels"]),
  shapeZyx: z.tuple([
    z.number().int().positive(),
    z.number().int().positive(),
    z.number().int().positive(),
  ]),
  /**
   * 4x4 row-major: voxel index (x,y,z) to world mm. The 3x3 part has
   * orthogonal columns (their lengths are the positive voxel spacings).
   */
  affine: z
    .tuple([row4, row4, row4, row4])
    .refine(isSpacedRigid, "affine needs orthogonal, nonzero columns and a bottom row of 0,0,0,1"),
  /** What the values are: `"HU"`, `"mm"`; null for raw or unitless. */
  unit: z.string().nullable(),
  /** Null when the producer ships the volume in no loadable format. */
  data: volumeDataSchema.nullable(),
});
export type Volume = z.infer<typeof volumeSchema>;

/**
 * Surface mesh in a binary file: `vertices` positions (3 float32 each: mm,
 * relative to `centerWorldMm`, little-endian), then `indices` uint32 triangle
 * corners (little-endian). World position = vertex + `centerWorldMm`. File size
 * is `vertices * 12 + indices * 4` bytes.
 */
export const meshSchema = z.object({
  key: storedKeySchema,
  /** Vertex count (not float count). */
  vertices: z.number().int().nonnegative(),
  /** Index count: three per triangle. */
  indices: z
    .number()
    .int()
    .nonnegative()
    .refine((n) => n % 3 === 0, "indices must be a multiple of 3"),
  sha256,
  centerWorldMm: vec3,
});

/** A segmented object: a label in a `labels` volume, usually with a surface. */
export const structureSchema = z.object({
  id: z.string(),
  name: z.string(),
  /**
   * Where its voxels are: a `labels` volume, and the value in it. An absent
   * `label` means every nonzero voxel (a binary mask). Null when the
   * segmentation is missing or the producer doesn't say.
   */
  voxels: z
    .object({ volumeId: z.string(), label: z.number().int().positive().optional() })
    .nullable(),
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
  /** The producer's own description, e.g. how a landmark was placed. */
  note: z.string().optional(),
};

/**
 * Something drawn in the views. Positions are world mm. The shell renders
 * every kind; a workflow chooses which to supply. A region of interest is a
 * structure, not an annotation. Next kinds (`plane`, `region`, `path`) are in
 * `.context/TODO.md`.
 */
export const annotationSchema = z.discriminatedUnion("kind", [
  /** A landmark. */
  z.object({ ...annotationBase, kind: z.literal("point"), position: vec3 }),
  /** A ruler between two endpoints, or an axis. */
  z.object({ ...annotationBase, kind: z.literal("line"), a: vec3, b: vec3 }),
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
  /** Structures it was counted from or drawn on. */
  structureIds: z.array(z.string()),
  /** Annotations that show it: the ruler of a distance, the landmarks it bounds. The only link between the two; annotations don't point back. */
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
  /** The task's latest `task` status in this attempt (`events.ts` fold); the importer sets `done`. */
  status: taskStatusSchema,
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

export const revisionSchema = z
  .object({
    id: z.string(),
    label: z.string(),
    createdAt: z.iso.datetime(),
    tasks: z.array(taskSchema),
    volumes: z.array(volumeSchema),
    structures: z.array(structureSchema),
    annotations: z.array(annotationSchema),
  })
  .superRefine((rev, ctx) => {
    // Importer output and older builds' data cross a trust boundary: a dangling
    // id would otherwise surface later as a blank overlay or a missing ruler.
    const bad = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: "custom", path, message });
    const idsOf = (xs: { id: string }[], block: string) => {
      const seen = new Set<string>();
      xs.forEach((x, i) => {
        if (seen.has(x.id)) bad([block, i, "id"], `duplicate id "${x.id}"`);
        seen.add(x.id);
      });
      return seen;
    };
    const volumes = idsOf(rev.volumes, "volumes");
    const structures = idsOf(rev.structures, "structures");
    const annotations = idsOf(rev.annotations, "annotations");
    const tasks = idsOf(rev.tasks, "tasks");
    const measurements = idsOf(
      rev.tasks.flatMap((t) => t.measurements),
      "tasks",
    );
    const kindOf = new Map(rev.volumes.map((v) => [v.id, v.kind]));
    // Each id in `ids` (optional ones may be undefined) must be in `known`.
    const needAll = (
      known: Set<string>,
      ids: (string | undefined)[],
      path: (string | number)[],
      what: string,
    ) => {
      ids.forEach((id, i) => {
        if (id !== undefined && !known.has(id)) bad([...path, i], `unknown ${what} "${id}"`);
      });
    };

    rev.volumes.forEach((v, i) => {
      if (v.data?.format !== "npy") return;
      const ok = v.kind === "image" ? imageDtype : labelDtype;
      if (!ok.safeParse(v.data.dtype).success)
        bad(
          ["volumes", i, "data", "dtype"],
          `${v.data.dtype} is not allowed for a ${v.kind} volume`,
        );
    });
    rev.structures.forEach((s, i) => {
      if (!s.voxels) return;
      const at = ["structures", i, "voxels"];
      needAll(volumes, [s.voxels.volumeId], [...at, "volumeId"], "volume");
      if (kindOf.has(s.voxels.volumeId) && kindOf.get(s.voxels.volumeId) !== "labels")
        bad([...at, "volumeId"], `volume "${s.voxels.volumeId}" is not a labels volume`);
    });
    needAll(
      volumes,
      rev.annotations.map((a) => a.volumeId),
      ["annotations", "volumeId"],
      "volume",
    );
    rev.tasks.forEach((t, ti) => {
      idsOf(t.evidence, "tasks");
      const task = ["tasks", ti];
      needAll(tasks, t.dependsOn, [...task, "dependsOn"], "task");
      needAll(structures, t.structureIds, [...task, "structureIds"], "structure");
      const own = new Set(t.evidence.map((e) => e.id));
      t.measurements.forEach((m, mi) => {
        const at = [...task, "measurements", mi];
        needAll(structures, m.structureIds, [...at, "structureIds"], "structure");
        needAll(annotations, m.annotationIds, [...at, "annotationIds"], "annotation");
        needAll(own, m.evidenceIds, [...at, "evidenceIds"], "evidence in this task");
        needAll(measurements, [m.numeratorId, m.denominatorId], [...at, "operands"], "measurement");
      });
    });
  });
export type Revision = z.infer<typeof revisionSchema>;

export const reviewRunSchema = z
  .object({
    id: runIdSchema,
    sample: z.string(),
    workflows: z.array(workflowPinSchema).min(1),
    /** Oldest first; the last is the latest. */
    revisions: z.array(revisionSchema).min(1),
  })
  .superRefine((run, ctx) => {
    const ids = new Set(run.revisions.map((r) => r.id));
    if (ids.size !== run.revisions.length)
      ctx.addIssue({ code: "custom", path: ["revisions"], message: "duplicate revision id" });
    run.revisions.forEach((r, ri) => {
      r.tasks.forEach((t, ti) => {
        if (!ids.has(t.resultRevisionId))
          ctx.addIssue({
            code: "custom",
            path: ["revisions", ri, "tasks", ti, "resultRevisionId"],
            message: `unknown revision "${t.resultRevisionId}"`,
          });
      });
    });
  });
export type ReviewRun = z.infer<typeof reviewRunSchema>;
