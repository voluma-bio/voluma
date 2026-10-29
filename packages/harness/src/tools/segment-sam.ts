/**
 * The `segment_sam` tool: SAM 3.1 box-prompted segmentation of a volume. The work happens in
 * the calling worker's sandbox, next to the data: this tool checks the paths and runs
 * `voluma-sam` (`packages/voluma-sam`), which reads the volume, crops it, sends it to Meta
 * through the run's gateway, decodes the masks and writes the labels `.npy` and a sidecar.
 * It returns the program's one-line result: paths, counts and the prompt, never voxels. It
 * bills nothing here: Meta's charge is a gateway row.
 */
import { type SamResult, samInput } from "@voluma/sam/input";
import type { RunLayout } from "../layout";
import type { Tool } from "./tool";

const TIMEOUT_SECONDS = 30 * 60;

export function segmentSamTool(layout: RunLayout): Tool<typeof samInput> {
  return {
    name: "segment_sam",
    description:
      "Segment structures in a volume with SAM 3.1: draw a box per structure on a slice and the model tracks " +
      "each through the whole volume. Returns a uint8 labels .npy of the volume's shape (0 is background, " +
      "each structure's voxels carry its label), the voxel count per label and the prompts used. The " +
      "structures of one call are tracked together and never share a voxel; a call is one paid request of " +
      "a few minutes (up to 16 structures), and results vary slightly between runs. Only the part of the volume " +
      "that holds tissue (or your `subVolume`) is sent. A sidecar JSON next to " +
      "the labels (`labels.npy` gives `labels.json`) holds `{axis, shape, crop, prompt, objects: [{label, name, promptFrame, box, " +
      'confidence: {"<slice>": 0-1}}]}`: the model\'s confidence for each object on each slice where it found a mask; ' +
      "a slice missing from `confidence` had none. The sidecar is written last: if a call was cut off, " +
      "the labels are complete only when it exists. " +
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
