/**
 * The `segment_plate` tool: the fine-tuned growth-plate model's proposal of the tibial plate's two faces. The work happens in
 * the calling worker's sandbox: this tool checks the paths and runs the mouse-oa skill's `plate_model.py`, which sends the
 * tibia grid's sections to the model (`plate-serve` on Modal) through the run's gateway, which holds the model's key, and
 * writes the proposal in `plate_faces.py`'s files. It returns the program's one-line result record, never voxels. It bills
 * nothing here: the model's time is a gateway row.
 */
import { z } from "zod";
import type { ThreadLayout } from "../layout";
import type { Tool } from "./tool";

/** The model answers in about a minute; the program gives up at 10 minutes, this a little later. */
const TIMEOUT_SECONDS = 12 * 60;

const input = z
  .object({
    hu: z
      .string()
      .describe(
        "tibia-hu.npy, the tibia long-axis grid tibia_frame.py wrote (its sidecar beside it).",
      ),
    mask: z.string().describe("tibia-mask.npy, written with it."),
    out: z.string().describe("Folder for the proposal, created; in your own folder."),
    window: z
      .string()
      .describe(
        "The QC sheets' display window: the scan's scan-settings.json (intake's), or `lo,hi` in HU. The model gets raw HU either way.",
      ),
    sections: z
      .array(z.number().int().min(0))
      .optional()
      .describe(
        "V indices of the sections to render in the QC sheets (default: every proposed section).",
      ),
  })
  .strict();

const quote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

export function segmentPlateTool(layout: ThreadLayout): Tool<typeof input> {
  return {
    name: "segment_plate",
    description:
      "Propose the tibial growth plate's proximal and distal faces with the fine-tuned plate model (mouse-oa, protocol step 2), " +
      "on the tibia long-axis grid tibia_frame.py wrote. Every tenth coronal section goes to the model; three checkpoints each " +
      "find the plate and their faces are combined, column by column. Writes, in `out`, the same files plate_faces.py writes: " +
      "`plate-annotations.json` (annotation A `growth_plate_curves` and C `growth_plate_distal_curves`, with the grid_id; no " +
      "points where it is flagged), `plate-faces.json` (`stretches`, the flagged columns: where the checkpoints disagree, too " +
      "few found the plate, or a face is off the tibia mask; `covered`, the V range and each section's U span) and " +
      "`qc-plate-<n>.jpg`, plus `plate-model.npz`, the model's reply, and `plate-band.npz`, its band as pieces (`pieces` in " +
      "plate-faces.json; `suspects` in the record: pieces with faces on a small separate bone, such as the fibula, for prune_plate.py). " +
      "Returns the result record. A call takes about a minute " +
      "(up to half a minute more when the model has been idle). It is a proposal, checked and retraced like plate_faces.py's. " +
      "If it returns an error, run plate_faces.py instead. " +
      `${layout.description}`,
    input,
    async execute(args, ctx) {
      layout.keyOf(args.hu, "read");
      layout.keyOf(args.mask, "read");
      layout.keyOf(args.out, "write");
      if (args.window.endsWith(".json")) layout.keyOf(args.window, "read");
      const sandbox = await ctx.sandbox();
      const flags = [
        `--hu-aligned ${quote(args.hu)}`,
        `--mask ${quote(args.mask)}`,
        `--out ${quote(args.out)}`,
        `--window ${quote(args.window)}`,
        ...(args.sections ? [`--sections ${args.sections.join(",")}`] : []),
      ];
      let stdout = "";
      let stderr = "";
      let exitCode = -1;
      for await (const chunk of sandbox.exec(
        { command: `python3 -m plate_model ${flags.join(" ")}`, timeoutSeconds: TIMEOUT_SECONDS },
        ctx.signal,
      )) {
        if (chunk.type === "exit") exitCode = chunk.code;
        else if (chunk.type === "stdout") stdout += chunk.data;
        else stderr += chunk.data;
      }
      const line = stdout.trim().split("\n").at(-1) ?? "";
      if (exitCode === 0 && line.startsWith("{"))
        return { output: line, isError: false, truncated: false };
      const why =
        exitCode === 124
          ? `plate_model.py was stopped after ${TIMEOUT_SECONDS / 60} minutes`
          : exitCode === 137
            ? "plate_model.py was killed (exit 137), most likely out of memory"
            : stderr.trim().slice(-1000) ||
              `plate_model.py exited with code ${exitCode} and said nothing`;
      return {
        output: `segment_plate failed: ${why}${why.includes("plate_faces.py") ? "" : "; run plate_faces.py instead"}`,
        isError: true,
        truncated: false,
      };
    },
  };
}
