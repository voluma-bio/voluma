/**
 * The `view_image` tool: shows the model PNG or JPEG files the sandbox wrote, so a worker
 * can look at its own renders. It reads them from the run's bucket on the host (the
 * sandbox mounts are the same objects; a file in the sandbox's /tmp is read through the
 * sandbox) and returns them as image content. The `tool.result` event keeps the text only:
 * each file's path, type, size and sha256.
 *
 * Limits, because every image enters the thread's history: at most 4 files per call (a sheet
 * of views, not a gallery), 1 MiB each, and 2000 px on a side (the most Claude accepts once a
 * request holds many images). A bigger image is downscaled to fit and re-encoded as JPEG, and
 * the result line says so. Images stay in the thread until a compaction summarizes them away
 * (`adapters/pi/compaction.ts`), which also keeps a request under the model's size limits.
 */
import { createHash } from "node:crypto";
import sharp from "sharp";
import { z } from "zod";
import type { ThreadLayout } from "../layout";
import type { Files } from "../ports/files";
import { readWhole } from "./read-whole";
import type { Tool } from "./tool";

const MAX_IMAGES = 4;
const MAX_BYTES = 1024 * 1024;
const MAX_SIDE = 2000;
// What is read before downscaling; a bigger file is not an image anyone wants shown.
const MAX_READ_BYTES = 64 * 1024 * 1024;

const inputSchema = z.object({
  paths: z
    .array(z.string())
    .min(1)
    .max(MAX_IMAGES)
    .describe(
      "PNG or JPEG files, in the order to show them. A relative path is read from your working folder.",
    ),
});

export interface ViewImageDeps {
  layout: ThreadLayout;
  files: Files;
  /** Whether the thread has a sandbox of its own to read a /tmp file from (it holds `bash`). */
  hasSandbox: boolean;
}

/** Fits the image in MAX_SIDE and MAX_BYTES: shrinks it, then lowers the JPEG quality, until it does. */
async function downscale(bytes: Buffer, width: number, height: number) {
  let scale = Math.min(1, MAX_SIDE / Math.max(width, height));
  for (;;) {
    const size = {
      width: Math.max(1, Math.round(width * scale)),
      height: Math.max(1, Math.round(height * scale)),
    };
    for (const quality of [85, 70, 55]) {
      const out = await sharp(bytes)
        .flatten({ background: "#ffffff" })
        .resize(size.width, size.height)
        .jpeg({ quality })
        .toBuffer();
      if (out.length <= MAX_BYTES) return { bytes: out, ...size };
    }
    scale *= 0.75;
  }
}

export function viewImageTool({
  layout,
  files,
  hasSandbox,
}: ViewImageDeps): Tool<typeof inputSchema> {
  return {
    name: "view_image",
    description:
      "Look at up to 4 image files you wrote (PNG or JPEG; one over 1 MiB or 2000 px a side is downscaled for you): they are returned as images, " +
      "in order, so you can check a render, an overlay or a plot. Only images; other files are refused. " +
      "Put several views on one sheet when you can. Images stay visible until your history is summarized; after that an older one shows as its text line, so call again to see it. " +
      layout.description,
    input: inputSchema,
    async execute({ paths }, ctx) {
      const images: { mimeType: string; data: string }[] = [];
      const lines: string[] = [];
      for (const named of paths) {
        const path = layout.resolve(named);
        const bytes = await readWhole(
          { layout, files, sandbox: hasSandbox ? ctx.sandbox : undefined },
          path,
          MAX_READ_BYTES,
          ctx.signal,
        );
        const meta = await sharp(bytes)
          .metadata()
          .catch(() => undefined);
        if (meta?.format !== "png" && meta?.format !== "jpeg") {
          throw new Error(`${path} is not a PNG or JPEG image`);
        }
        const { width, height } = meta;
        const big = bytes.length > MAX_BYTES || Math.max(width, height) > MAX_SIDE;
        const shown = big ? await downscale(bytes, width, height) : { bytes, width, height };
        const mimeType = big ? "image/jpeg" : `image/${meta.format}`;
        const sha256 = createHash("sha256").update(shown.bytes).digest("hex");
        images.push({ mimeType, data: shown.bytes.toString("base64") });
        lines.push(
          `${path} (${mimeType}, ${shown.width} x ${shown.height} px, ${shown.bytes.length} bytes, sha256 ${sha256}` +
            (big ? `; downscaled from ${width} x ${height} px, ${bytes.length} bytes)` : ")"),
        );
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
