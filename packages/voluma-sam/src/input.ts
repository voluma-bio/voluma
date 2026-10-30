/**
 * The input of `voluma-sam` and of the `segment_sam` tool that runs it: one schema, so the
 * model-facing description and the program's validation cannot drift apart. The result type is
 * the program's one JSON line.
 */
import { z } from "zod";

/** Objects one request can carry (Meta's limit). */
export const MAX_STRUCTURES = 16;

export const samInput = z
  .object({
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
        z
          .object({
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
          })
          .strict(),
      )
      .min(1)
      .max(MAX_STRUCTURES)
      .refine(
        (s) => new Set(s.map((x) => x.label)).size === s.length,
        "structure labels must be unique",
      ),
    subVolume: z
      .tuple([
        z.number().int(),
        z.number().int(),
        z.number().int(),
        z.number().int(),
        z.number().int(),
        z.number().int(),
      ])
      .optional()
      .describe(
        "[z0, z1, r0, r1, c0, c1]: only this part of the volume is encoded and sent, ends inclusive, in the " +
          "volume's own axes (0, 1, 2), whatever `axis` is. The labels still come back on the full grid, " +
          "0 outside it. Absent: the tool crops to the voxels above the window's low value, plus a margin, " +
          "and to every box you draw. The model tracks nothing outside the crop, so a sub-volume that cuts " +
          "through a structure cuts its mask.",
      ),
    output: z
      .string()
      .describe(
        "Where to write the labels .npy, under /outputs or /scratch. Next to it the tool writes `<output without .npy>.json`.",
      ),
  })
  // The program in the sandbox image is pinned separately from the harness: a field it does not
  // know must fail the call, not be dropped (`../AGENTS.md`).
  .strict();

export type SamInput = z.infer<typeof samInput>;

/** `[z0, z1, r0, r1, c0, c1]`, ends inclusive. */
export type Crop = [number, number, number, number, number, number];

/** How Meta's reply arrived, in ms from the request's start (`bytes` and `events` are counts). */
export interface StreamStats {
  /** The first `data:` event; keepalive comments do not count. Undefined if none came. */
  firstEventMs: number | undefined;
  /** The longest time between chunks other than lone keepalive comments (a long `data:` line arriving is not silence), the wait for the first included. */
  longestGapMs: number;
  /** When that gap ended. */
  longestGapAtMs: number;
  bytes: number;
  events: number;
}

export interface SamResult {
  output: string;
  shape: [number, number, number];
  counts: { label: number; name: string; voxels: number }[];
  sidecar: string;
  /** The prompt as sent: frames and boxes are the crop's own. */
  prompt: string;
  /** Frames Meta processed (what it billed). */
  frames: number;
  requestId: string | undefined;
  /** The part of the volume that was sent. */
  crop: Crop;
  /** Wall milliseconds per stage. */
  timings: Record<string, number>;
  /** How Meta's reply arrived: the data for the gateway's time limits. */
  stream: StreamStats;
}
