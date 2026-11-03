/**
 * The input of `voluma-sam` and of the `segment_sam` tool that runs it: one schema, so the
 * model-facing description and the program's validation cannot drift apart. The result type is
 * the program's one JSON line.
 */
import { z } from "zod";

/** Objects one request can carry (Meta's limit). */
export const MAX_STRUCTURES = 16;

const box = z
  .tuple([z.number().int(), z.number().int(), z.number().int(), z.number().int()])
  .describe("[row0, col0, row1, col1] in pixels of the slice, ends inclusive.");

const point = z
  .object({
    row: z.number().int(),
    col: z.number().int(),
    negative: z
      .boolean()
      .optional()
      .describe(
        "true: this pixel is NOT the structure (keeps a neighbour out). Absent: it is part of it.",
      ),
  })
  .strict();

/** What a prompt holds: at least a box or one positive point. */
const hasTarget = (p: { box?: unknown; points?: { negative?: boolean }[] }) =>
  p.box !== undefined || (p.points ?? []).some((q) => !q.negative);
const NEEDS_TARGET =
  "a prompt needs a `box` or at least one positive point (negative points only say what to keep out)";

const promptFields = {
  box: box.optional().describe("The whole structure, on this slice. At most one box per slice."),
  points: z
    .array(point)
    .min(1)
    .optional()
    .describe("Pixels of this slice: positive ones on the structure, `negative` ones off it."),
};

export const samInput = z
  .object({
    volume: z
      .string()
      .describe(
        "Path of a 3D .npy (uint8, uint16, int16, int32 or float32), or a 2D one (a single image: the whole call is one image, slice 0), under /inputs, /outputs or /scratch.",
      ),
    axis: z
      .union([z.literal(0), z.literal(1), z.literal(2)])
      .optional()
      .describe(
        "The volume axis to slice along (required for a 3D volume, ignored for a 2D array). Prompts are drawn on slices: rows run along the lower of the other two axes, columns along the higher.",
      ),
    keyframe: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("The slice the prompts are drawn on unless a prompt names its own `frame`."),
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
            frame: z
              .number()
              .int()
              .min(0)
              .optional()
              .describe("The slice of this structure's `box` and `points`, if not `keyframe`."),
            ...promptFields,
            otherFrames: z
              .array(
                z
                  .object({ frame: z.number().int().min(0), ...promptFields })
                  .strict()
                  .refine(hasTarget, NEEDS_TARGET),
              )
              .min(1)
              .optional()
              .describe(
                "More prompts for this structure on other slices, one entry per slice (pull a drifting track back). Tracking starts at the earliest prompted slice.",
              ),
          })
          .strict()
          .refine(hasTarget, NEEDS_TARGET),
      )
      .min(1)
      .max(MAX_STRUCTURES)
      .refine(
        (s) => new Set(s.map((x) => x.label)).size === s.length,
        "structure labels must be unique",
      )
      .optional()
      .describe("Box and point prompts, one per structure. Give this or `concept`, never both."),
    concept: z
      .object({
        phrase: z
          .string()
          .min(1)
          .describe('One noun phrase ("bone", "red hat"). Not a list, a question or a negation.'),
        firstLabel: z
          .number()
          .int()
          .min(1)
          .max(240)
          .optional()
          .describe(
            "Label of the first instance found (default 1); the next ones follow in the order the model first shows them.",
          ),
      })
      .strict()
      .optional()
      .describe(
        "Segment every instance of a phrase (a video tracks up to 16 per frame, an image any number); the model decides how many there are, and the call fails if their labels would pass 255. Give this or `structures`, never both.",
      ),
    direction: z
      .enum(["both", "forward", "backward"])
      .optional()
      .describe(
        "Box and point prompts only: which way tracking runs from the earliest prompted slice (default both). Meta bills the slices tracked (at least 50), so `forward` or `backward` with a `subVolume` is cheaper when the structure lies one way.",
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
          "volume's own axes (0, 1, 2), whatever `axis` is (a 2D array: [0, 0, r0, r1, c0, c1]). The labels still come back on the full grid, " +
          "0 outside it. Absent: the tool crops to the voxels above the window's low value, plus a margin, " +
          "and to every box and point you draw. The model tracks nothing outside the crop, so a sub-volume that cuts " +
          "through a structure cuts its mask; every prompt must lie inside it.",
      ),
    output: z
      .string()
      .describe(
        "Where to write the labels .npy: only in your own $WORK folder (/outputs is read-only). Next to it the tool writes `<output without .npy>.json`.",
      ),
  })
  // The program in the sandbox image is pinned separately from the harness: a field it does not
  // know must fail the call, not be dropped (`../AGENTS.md`).
  .strict()
  .superRefine((input, ctx) => {
    if ((input.structures === undefined) === (input.concept === undefined))
      ctx.addIssue({
        code: "custom",
        message:
          "give either `structures` (box and point prompts) or `concept`, not both and not neither",
      });
    if (input.concept && input.direction)
      ctx.addIssue({
        code: "custom",
        path: ["direction"],
        message:
          "`direction` applies to box and point prompts only; a concept prompt always tracks the whole volume",
      });
  });

export type SamInput = z.infer<typeof samInput>;

export type Box4 = [number, number, number, number];
export type Point = { row: number; col: number; negative?: boolean };
/** The prompts of one object on one slice, as the slice's own pixels. */
export interface Prompt {
  frame: number;
  box?: Box4;
  points: Point[];
}

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
  /** The array's own shape (2D for an image). */
  shape: number[];
  counts: { label: number; name: string; voxels: number }[];
  sidecar: string;
  /** The prompt text as sent: frames, boxes and points are the crop's own. */
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
