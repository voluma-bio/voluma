/**
 * The `view_image` tool: shows the model PNG or JPEG files the sandbox wrote, so a worker
 * can look at its own renders. It reads them from the run's bucket on the host (the
 * sandbox mounts are the same objects) and returns them as image content. The
 * `tool.result` event keeps the text only: each file's path, type, size and sha256.
 *
 * Limits, because every image stays in the thread's history and is resent with each later
 * request: at most 4 files per call (a sheet of views, not a gallery) and 1 MiB each (a
 * 1500 px PNG render is well under it; a bigger one should be downscaled or saved as JPEG).
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import type { RunLayout } from "../layout";
import type { Files } from "../ports/files";
import type { Tool } from "./tool";

const MAX_IMAGES = 4;
const MAX_BYTES = 1024 * 1024;

const inputSchema = z.object({
  paths: z
    .array(z.string())
    .min(1)
    .max(MAX_IMAGES)
    .describe("PNG or JPEG files under /inputs, /outputs or /scratch, in the order to show them."),
});

export interface ViewImageDeps {
  layout: RunLayout;
  files: Files;
}

/** The type from the file's first bytes, never its name. */
function imageType(bytes: Uint8Array): "image/png" | "image/jpeg" | undefined {
  const starts = (magic: number[]) => magic.every((b, i) => bytes[i] === b);
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (starts([0xff, 0xd8, 0xff])) return "image/jpeg";
  return undefined;
}

export function viewImageTool({ layout, files }: ViewImageDeps): Tool<typeof inputSchema> {
  return {
    name: "view_image",
    description:
      "Look at up to 4 image files you wrote (PNG or JPEG, at most 1 MiB each): they are returned as images, " +
      "in order, so you can check a render, an overlay or a plot. Only images; other files are refused. " +
      "Put several views on one sheet when you can. " +
      layout.description,
    input: inputSchema,
    async execute({ paths }, ctx) {
      const images: { mimeType: string; data: string }[] = [];
      const lines: string[] = [];
      for (const path of paths) {
        const key = layout.keyOf(path, "read");
        const chunks: Uint8Array[] = [];
        let size = 0;
        for await (const chunk of files.read(key, ctx.signal)) {
          size += chunk.length;
          if (size > MAX_BYTES) {
            throw new Error(`${path} is over ${MAX_BYTES} bytes: downscale it or save it as JPEG`);
          }
          chunks.push(chunk);
        }
        const bytes = Buffer.concat(chunks);
        const mimeType = imageType(bytes);
        if (!mimeType) throw new Error(`${path} is not a PNG or JPEG image`);
        const sha256 = createHash("sha256").update(bytes).digest("hex");
        images.push({ mimeType, data: bytes.toString("base64") });
        lines.push(`${path} (${mimeType}, ${size} bytes, sha256 ${sha256})`);
      }
      return {
        output: `Showing ${images.length} image${images.length === 1 ? "" : "s"}, in order:\n${lines.join("\n")}`,
        isError: false,
        truncated: false,
        images,
      };
    },
  };
}
