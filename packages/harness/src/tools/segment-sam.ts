/**
 * The `segment_sam` tool: SAM 3.1 segmentation of a volume or image from box, point or concept prompts. The work happens in
 * the calling worker's sandbox, next to the data: this tool checks the paths and runs
 * `voluma-sam` (`packages/voluma-sam`), which reads the volume, crops it, sends it to Meta
 * through the run's gateway, decodes the masks and writes the labels `.npy` and a sidecar.
 * It returns the program's one-line result: paths, counts and the prompt, never voxels. It
 * bills nothing here: Meta's charge is a gateway row.
 */
import { type SamResult, samInput } from "@voluma/sam/input";
import type { ThreadLayout } from "../layout";
import type { Tool } from "./tool";

const TIMEOUT_SECONDS = 30 * 60;

export function segmentSamTool(layout: ThreadLayout): Tool<typeof samInput> {
  return {
    name: "segment_sam",
    description:
      "Segment structures in a volume or an image with SAM 3.1. Prompt each structure with a box and/or points on a " +
      "slice (a point can be negative: this pixel is not the structure) and the model tracks it through the whole " +
      "volume; add `otherFrames` prompts on more slices to pull a drifting track back, and `direction` to track only " +
      "one way from the earliest prompted slice (Meta bills the slices tracked). Or give a `concept`, one noun phrase, " +
      "and the model finds every instance (up to 16) and tracks them; its ids become labels in the order they first " +
      "appear (a phrase that matches nothing returns no objects, not an error). A 2D .npy is one image: its prompts are on slice 0. Returns a uint8 labels .npy of the input's shape " +
      "(0 is background, each structure's voxels carry its label), the voxel count per label and the prompt text " +
      "sent. The structures of one call are tracked together and never share a voxel; a call is one paid request of " +
      "a few minutes (up to 16 structures), and results vary slightly between runs. Only the part of the volume " +
      "that holds tissue (or your `subVolume`) is sent, and every prompt must lie inside it. A sidecar JSON next to " +
      "the labels (`labels.npy` gives `labels.json`) holds `{axis, shape, crop, prompt, direction, objects: [{label, name, " +
      'prompts: [{frame, box, points}] (a concept\'s objects have `modelId` instead), confidence: {"<slice>": 0-1}}]}`: ' +
      "the model's confidence for each object on each slice where it found a mask; " +
      "a slice missing from `confidence` had none. The sidecar also holds the call's `requestId`, which the result repeats. " +
      "An earlier sidecar is deleted when a call starts writing and the new one is written last: the labels are complete " +
      "only when the sidecar exists and its `requestId` is the one the call returned. " +
      `${layout.description}`,
    input: samInput,
    async execute(input, ctx) {
      layout.keyOf(input.volume, "read");
      layout.keyOf(input.output, "write");
      const sandbox = await ctx.sandbox();
      let stdout = "";
      let stderr = "";
      let exitCode = -1;
      const command = `voluma-sam <<'VOLUMA_SAM_INPUT'\n${JSON.stringify(input)}\nVOLUMA_SAM_INPUT`;
      for await (const chunk of sandbox.exec(
        { command, timeoutSeconds: TIMEOUT_SECONDS },
        ctx.signal,
      )) {
        if (chunk.type === "exit") exitCode = chunk.code;
        else if (chunk.type === "stdout") stdout += chunk.data;
        else {
          stderr += chunk.data;
          ctx.output("stderr", chunk.data);
        }
      }
      const line = stdout.trim().split("\n").at(-1) ?? "";
      let reply: (Partial<SamResult> & { error?: string; infrastructure?: true }) | undefined;
      try {
        reply = JSON.parse(line);
      } catch {
        // The program was killed or never ran: no result line.
      }
      if (exitCode === 0 && reply && !reply.error)
        return { output: line, isError: false, truncated: false };
      const why =
        reply?.error ??
        (exitCode === 124
          ? `voluma-sam was stopped after ${TIMEOUT_SECONDS / 60} minutes`
          : exitCode === 137
            ? "voluma-sam was killed (exit 137), most likely out of memory: pass a smaller `subVolume`"
            : `voluma-sam exited with code ${exitCode} without a result: ${stderr.slice(-1000)}`);
      return {
        output: why,
        isError: true,
        truncated: false,
        ...(reply?.infrastructure && { infrastructure: true as const }),
      };
    },
  };
}
