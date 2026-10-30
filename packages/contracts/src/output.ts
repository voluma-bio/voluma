/**
 * What a task reports: one `output` per result, of one of the review's
 * building blocks. Only `outputId`, `title` (the block's name) and `evidence`
 * are common. A value's fields (`value`, `unit`, `level`, `confidence`, `note`,
 * `definition`, a volume's grid and unit) and the tuples
 * (`shapeZyxSchema`, `voxelIndexSchema`) are picked from `review.ts`, so there is
 * one definition of each. What a report adds to its block is the files and voxels
 * the fold turns into keys, world mm and `volumeId`; the block's links are not reported.
 *
 * - `measurement`, `score`: a number with a unit; a level of a scale. Both
 *   carry `confidence`, `note` and `definition`. What they are shown with
 *   (`on`, `context`) is in the declaration (`workflow-files.ts`), not here.
 * - `structure`: a label in its declared grid (a `labels` volume), a mask
 *   cropped to its bounding box on the grid, or "missing" with a reason.
 * - `surface`: a height field on its declared grid, along an array axis.
 * - `annotation`: a point or a line in voxels `[z, y, x]` of its declared grid,
 *   fractional allowed. The fold maps it to world mm through the grid's affine.
 *   A mask, surface or annotation also reports, in its own payload, the `gridId` of the
 *   grid it was made on; `report_output` refuses it when that differs from the `gridId`
 *   its declared grid volume reported.
 * - `volume`: an `.npy` voxel grid on its own affine.
 * - `file`: a figure, table or report; its `title` is its name.
 * - `missing`: the output could not be made. It fills whatever the declaration for its
 *   `outputId` is, of any kind, and `reason` says why. It counts as reported (the task did its
 *   job and said so); the review shows the output missing with the reason. A measurement
 *   keeps its own `value: null` with a reason; `missing` on a measurement declaration is refused.
 *
 * An object (structure, surface, annotation, volume) must be declared: review
 * places it by its declaration's grid. A reference to another output (a ratio's
 * operands) is its `outputId` in the same task, or `taskId/outputId`.
 * Files are named by evidence ref and
 * copied like evidence: the event holds `{root, path, sha256}`, the tool call
 * `{root, path}`, so each schema is built twice from one definition.
 */
import { z } from "zod";
import { segmentSchema } from "./ids";
import { relativePathSchema, sha256Schema } from "./r2";
import {
  assetSchema,
  measurementSchema,
  npyDtypeSchema,
  scoreSchema,
  shapeZyxSchema,
  structureSchema,
  surfaceSchema,
  volumeSchema,
  voxelIndexSchema,
} from "./review";

const nonEmpty = z.string().min(1);

/**
 * A file the agent named, as recorded: copied to `evidenceKey(runId, sha256)`
 * before the event is appended, so a rerun can't erase it. `path` is under
 * `root`: `outputs` is the task's output folder (`outputKey`), `scratch` the
 * run's scratch (`scratchKey`), where a check thread keeps its reproductions. A tool call's
 * scratch path is relative to the caller's own folder unless it starts with a thread name;
 * the event holds the full form. The runtime scopes every path to this run.
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
    .describe(
      "`outputs`: `path` is inside /outputs/<task id>/. `scratch`: `path` is inside your working folder $SCRATCH.",
    ),
  path: relativePathSchema,
});

/** A position in voxel coordinates `[z, y, x]` of a grid; fractional allowed. */
const positionZyx = z.tuple([z.number().min(0), z.number().min(0), z.number().min(0)]);

const gridIdField = volumeSchema.shape.gridId.describe(
  "The grid_id of the grid's sidecar, as reported on its volume.",
);

const outputs = <R extends z.ZodType>(ref: R) => {
  const prose = { note: true, definition: true } as const;
  return z.discriminatedUnion("kind", [
    measurementSchema
      .pick({
        value: true,
        unit: true,
        confidence: true,
        ...prose,
        numeratorId: true,
        denominatorId: true,
      })
      .extend({ kind: z.literal("measurement") }),
    scoreSchema
      .pick({ level: true, confidence: true, ...prose })
      .extend({ kind: z.literal("score") }),
    z.object({
      definition: structureSchema.shape.definition,
      volumeMm3: structureSchema.shape.volumeMm3,
      kind: z.literal("structure"),
      structure: z.union([
        z.strictObject({
          label: z.number().int().positive().describe("The structure's value in its grid."),
        }),
        z.strictObject({
          mask: ref.describe("uint8 `.npy`, 1 inside, cropped to the structure's bounding box."),
          gridId: gridIdField,
          shapeZyx: shapeZyxSchema,
          offsetZyx: voxelIndexSchema.describe(
            "Voxel of the grid where the mask's [0, 0, 0] sits.",
          ),
        }),
      ]),
    }),
    z.object({
      kind: z.literal("surface"),
      surface: z.object({
        gridId: gridIdField,
        axis: surfaceSchema.shape.axis.describe("The array axis the heights are measured along."),
        heights: ref.describe(
          "float32 `.npy`: the grid's shape without `axis`; NaN where the surface is off the bone.",
        ),
      }),
    }),
    z.object({
      kind: z.literal("annotation"),
      note: z.string().optional(),
      annotation: z.discriminatedUnion("kind", [
        z.object({ gridId: gridIdField, kind: z.literal("point"), zyx: positionZyx }),
        z.object({
          gridId: gridIdField,
          kind: z.literal("line"),
          aZyx: positionZyx,
          bZyx: positionZyx,
        }),
      ]),
    }),
    z.object({
      kind: z.literal("volume"),
      volume: volumeSchema
        .pick({ kind: true, shapeZyx: true, affine: true, unit: true, gridId: true })
        .extend({ file: ref, dtype: npyDtypeSchema }),
    }),
    z.object({
      kind: z.literal("file"),
      file: ref,
      mediaType: assetSchema.shape.mediaType.unwrap(),
    }),
    z.object({ kind: z.literal("missing"), reason: nonEmpty }),
  ]);
};

/** The parts every kind shares. `title` becomes the block's `name` (a measurement's or score's `title`). */
const report = <R extends z.ZodType>(ref: R) =>
  z.object({
    outputId: segmentSchema.describe(
      "Stable name for this output within the task; reuse it when you redo the task.",
    ),
    title: nonEmpty,
    evidence: z.array(ref).describe("Files the output rests on."),
    output: outputs(ref),
  });

/** The event's payload, less `taskId` and `attemptId`. */
export const outputReportSchema = report(evidenceRefSchema);
/** The `report_output` call, less `taskId`. */
export const outputReportInputSchema = report(fileRefInputSchema);
export type Output = z.infer<typeof outputReportSchema>["output"];

/** The files an output's own payload names: its `file`, a volume's `file`, a structure's mask, a surface's heights. */
export const fileRefsOf = (output: Output): EvidenceRef[] => {
  switch (output.kind) {
    case "file":
      return [output.file];
    case "volume":
      return [output.volume.file];
    case "structure":
      return "mask" in output.structure ? [output.structure.mask] : [];
    case "surface":
      return [output.surface.heights];
    default:
      return [];
  }
};
