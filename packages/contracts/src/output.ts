/**
 * What a task reports: one `output` per result, of one of the review's
 * building blocks. The payload of each kind is derived from the schema in
 * `review.ts` that the fold fills from it, so there is one definition of each
 * block.
 *
 * - `measurement`, `score`: a number with a unit; a level of a scale.
 * - `structure`: a label in a `volume` output of kind `labels` (named by
 *   `volume`), optionally with a surface mesh.
 * - `annotation`: a point or a line, in world mm.
 * - `volume`: an `.npy` voxel grid on its own affine.
 * - `file`: a figure, table or report.
 *
 * `annotation` and `volume` nest their block under the same key because the
 * block has its own `kind`. A reference to another output is its `outputId` in
 * the same task, or `taskId/outputId`. Files are named by evidence ref and
 * copied like evidence: the event holds `{root, path, sha256}`, the tool call
 * `{root, path}`, so each schema is built twice from one definition.
 */
import { z } from "zod";
import { relativePathSchema, segmentSchema, sha256Schema } from "./r2";
import {
  lineAnnotationSchema,
  measurementSchema,
  meshSchema,
  npyDtypeSchema,
  pointAnnotationSchema,
  scoreSchema,
  structureSchema,
  volumeSchema,
} from "./review";

const nonEmpty = z.string().min(1);

/**
 * A file the agent named, as recorded: copied to `evidenceKey(runId, sha256)`
 * before the event is appended, so a rerun can't erase it. `path` is under
 * `root`: `outputs` is the task's output folder (`outputKey`), `scratch` the
 * run's scratch (`scratchKey`), where a check thread keeps its reproductions.
 * The runtime scopes every path to this run.
 */
export const evidenceRefSchema = z.object({
  root: z.enum(["outputs", "scratch"]),
  path: relativePathSchema,
  sha256: sha256Schema,
});
export type EvidenceRef = z.infer<typeof evidenceRefSchema>;

/** The same file as the agent names it in a tool call. */
export const fileRefInputSchema = z.object({
  root: z
    .enum(["outputs", "scratch"])
    .default("outputs")
    .describe("`outputs` is this task's output folder; `scratch` is the run's scratch."),
  path: relativePathSchema,
});

const outputs = <R extends z.ZodType>(ref: R) => {
  const mesh = meshSchema.omit({ key: true, sha256: true }).extend({ file: ref });
  return z.discriminatedUnion("kind", [
    measurementSchema
      .pick({
        value: true,
        unit: true,
        structureIds: true,
        annotationIds: true,
        numeratorId: true,
        denominatorId: true,
      })
      .extend({ kind: z.literal("measurement") }),
    scoreSchema.pick({ level: true }).extend({ kind: z.literal("score") }),
    z.object({
      kind: z.literal("structure"),
      /** A `volume` output of kind `labels`. */
      volume: nonEmpty,
      /** Absent: every nonzero voxel of the volume (a binary mask). */
      label: structureSchema.shape.voxels.unwrap().shape.label,
      volumeMm3: structureSchema.shape.volumeMm3,
      mesh: mesh.optional(),
    }),
    z.object({
      kind: z.literal("annotation"),
      annotation: z.discriminatedUnion("kind", [
        pointAnnotationSchema.omit({ id: true, name: true, note: true }),
        lineAnnotationSchema.omit({ id: true, name: true, note: true }),
      ]),
    }),
    z.object({
      kind: z.literal("volume"),
      volume: volumeSchema
        .pick({ kind: true, shapeZyx: true, affine: true, unit: true })
        .extend({ file: ref, dtype: npyDtypeSchema }),
    }),
    z.object({ kind: z.literal("file"), file: ref, mediaType: nonEmpty }),
  ]);
};

/** The parts every kind shares. A task's `title`, `note` and `definition` become the block's `name`, `note` and `definition`. */
const report = <R extends z.ZodType>(ref: R) =>
  z.object({
    outputId: segmentSchema.describe(
      "Stable name for this output within the task; reuse it when you redo the task.",
    ),
    title: nonEmpty,
    note: z.string().optional(),
    definition: z.string().optional(),
    confidence: measurementSchema.shape.confidence,
    evidence: z.array(ref).describe("Files the output rests on."),
    output: outputs(ref),
  });

/** The event's payload, less `taskId` and `attemptId`. */
export const outputReportSchema = report(evidenceRefSchema);
/** The `report_output` call, less `taskId`. */
export const outputReportInputSchema = report(fileRefInputSchema);
export type Output = z.infer<typeof outputReportSchema>["output"];
