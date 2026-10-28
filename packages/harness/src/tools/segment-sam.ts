/**
 * The `segment_sam` tool: SAM 3.1 box-prompted segmentation of a volume. It runs in the
 * runner, not the sandbox: the sandbox has no network, and the provider key must not enter
 * it. The model names a volume (`.npy`) under /inputs, /outputs or /scratch; the tool reads
 * it from the bucket as an 8-bit windowed stack along `axis`, has the Segmenter track the
 * boxed structures through every slice, and writes a uint8 labels `.npy` of the volume's
 * shape. It returns paths, counts and prompts, never voxels.
 */
import { z } from "zod";
import type { RunLayout } from "../layout";
import { readWindowed, type Shape3, writeU8 } from "../npy";
import type { Files } from "../ports/files";
import type { Segmenter, SegmentObject } from "../ports/segmenter";
import type { Tool } from "./tool";

/** Objects one request can carry (Meta's limit). */
const MAX_STRUCTURES = 16;

const inputSchema = z.object({
  volume: z
    .string()
    .describe(
      "Path of a 3D .npy (uint8, uint16, int16, int32 or float32) under /inputs, /outputs or /scratch.",
    ),
  axis: z
    .union([z.literal(0), z.literal(1), z.literal(2)])
    .describe(
      "The volume axis to slice along. Boxes are drawn on slices: rows run along the lower of the other two axes, columns along the higher.",
    ),
  keyframe: z
    .number()
    .int()
    .min(0)
    .describe("The slice the boxes are drawn on, unless a structure names its own `frame`."),
  window: z
    .tuple([z.number(), z.number()])
    .refine(([lo, hi]) => lo < hi, "window is [low, high] with low < high")
    .describe(
      "Intensity range mapped to 0-255 (for CT, HU values such as [1000, 8000]); outside it clips.",
    ),
  structures: z
    .array(
      z.object({
        label: z
          .number()
          .int()
          .min(1)
          .max(255)
          .describe("The value its voxels carry in the output."),
        name: z.string().min(1),
        box: z
          .tuple([z.number().int(), z.number().int(), z.number().int(), z.number().int()])
          .describe("[row0, col0, row1, col1] in pixels of the slice, ends inclusive."),
        frame: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe(
            "Draw this box on another slice than `keyframe` (a structure that is clear there).",
          ),
      }),
    )
    .min(1)
    .max(MAX_STRUCTURES),
  output: z.string().describe("Where to write the labels .npy, under /outputs or /scratch."),
});

export interface SegmentSamDeps {
  layout: RunLayout;
  files: Files;
  segmenter: Segmenter;
  /** Called with what the provider billed. */
  addCost(usd: number): void;
}

export function segmentSamTool(deps: SegmentSamDeps): Tool<typeof inputSchema> {
  const { layout, files, segmenter } = deps;
  return {
    name: "segment_sam",
    description:
      "Segment structures in a volume with SAM 3.1: draw a box per structure on a slice and the model tracks " +
      "each through the whole volume. Returns a uint8 labels .npy of the volume's shape (0 is background, " +
      "each structure's voxels carry its label), the voxel count per label and the prompts used. The " +
      "structures of one call are tracked together and never share a voxel; a call is one paid request of " +
      "about a minute (up to 16 structures), and results vary slightly between runs. " +
      `${layout.description}`,
    input: inputSchema,
    async execute(input, ctx) {
      const { axis } = input;
      const labels = new Set(input.structures.map((s) => s.label));
      if (labels.size !== input.structures.length)
        throw new Error("structure labels must be unique");
      const readKey = layout.keyOf(input.volume, "read");
      const writeKey = layout.keyOf(input.output, "write");
      const { shape, data } = await readWindowed(files.read(readKey, ctx.signal), input.window);
      const [count, height, width] = frameShape(shape, axis);
      const objects: SegmentObject[] = input.structures.map(({ label, box, frame }) => {
        const f = frame ?? input.keyframe;
        const [r0, c0, r1, c1] = box;
        if (f >= count)
          throw new Error(`slice ${f} is outside the ${count} slices along axis ${axis}`);
        if (r0 < 0 || c0 < 0 || r1 >= height || c1 >= width || r0 > r1 || c0 > c1) {
          throw new Error(
            `box [${box}] of label ${label} does not fit a ${height} x ${width} slice`,
          );
        }
        return { label, frame: f, box };
      });
      const stack = { data: moveAxis(data, shape, axis, "to-front"), count, height, width };
      const result = await segmenter.segment(stack, objects, ctx.signal);
      deps.addCost(result.costUsd);
      const volume = moveAxis(result.labels, shape, axis, "to-place");
      await files.write(writeKey, writeU8(volume, shape), ctx.signal);
      const voxels = new Uint32Array(256);
      for (const v of volume) voxels[v] = (voxels[v] ?? 0) + 1;
      return {
        output: JSON.stringify({
          output: input.output,
          shape,
          counts: input.structures.map((s) => ({
            label: s.label,
            name: s.name,
            voxels: voxels[s.label] ?? 0,
          })),
          prompt: result.prompt,
          costUsd: result.costUsd,
        }),
        isError: false,
        truncated: false,
      };
    },
  };
}

type Axis = 0 | 1 | 2;

/** The row and column axes of a slice taken along `axis`. */
const sliceAxes = (axis: Axis): [Axis, Axis] =>
  axis === 0 ? [1, 2] : axis === 1 ? [0, 2] : [0, 1];

/** [slices, rows, cols] when slicing a volume of `shape` along `axis`. */
function frameShape(shape: Shape3, axis: Axis): Shape3 {
  const [r, c] = sliceAxes(axis);
  return [shape[axis], shape[r], shape[c]];
}

/**
 * Reorders a volume of `shape` (stored `to-place`) to slice-major along `axis` (`to-front`), or
 * back. Axis 0 is already slice-major, and the same buffer comes back.
 */
export function moveAxis(
  src: Uint8Array,
  shape: Shape3,
  axis: Axis,
  direction: "to-front" | "to-place",
): Uint8Array {
  if (axis === 0) return src;
  const strides: Shape3 = [shape[1] * shape[2], shape[2], 1];
  const [r, c] = sliceAxes(axis);
  const [count, rows, cols] = frameShape(shape, axis);
  const dst = new Uint8Array(src.length);
  let k = 0;
  for (let f = 0; f < count; f++) {
    for (let i = 0; i < rows; i++) {
      const base = f * strides[axis] + i * strides[r];
      for (let j = 0; j < cols; j++, k++) {
        const placed = base + j * strides[c];
        if (direction === "to-front") dst[k] = src[placed] ?? 0;
        else dst[placed] = src[k] ?? 0;
      }
    }
  }
  return dst;
}
