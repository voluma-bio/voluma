/**
 * The `view_image` tool: shows the model PNG or JPEG files the sandbox wrote, so a worker
 * can look at its own renders. It reads them from the run's bucket on the host (the
 * sandbox mounts are the same objects) and returns them as image content. The
 * `tool.result` event keeps the text only: each file's path, type, size and sha256.
 *
 * Limits, because every image enters the thread's history: at most 4 files per call (a sheet
 * of views, not a gallery), 1 MiB each, and 2000 px on a side (the most Claude accepts once a
 * request holds many images; a bigger render should be downscaled). Requests carry only the
 * last two calls' images (`adapters/pi/elide-images.ts`).
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import type { RunLayout } from "../layout";
import type { Files } from "../ports/files";
import type { Tool } from "./tool";

const MAX_IMAGES = 4;
const MAX_BYTES = 1024 * 1024;
const MAX_SIDE = 2000;

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

/** Width and height from the PNG header or the JPEG's first frame header; undefined if neither parses. */
function dimensions(
  bytes: Uint8Array,
  type: "image/png" | "image/jpeg",
): [number, number] | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (type === "image/png") {
    return bytes.length >= 24 ? [view.getUint32(16), view.getUint32(20)] : undefined;
  }
  for (let i = 2; i + 9 < bytes.length; ) {
    if (bytes[i] !== 0xff) return undefined;
    const marker = bytes[i + 1] ?? 0;
    // Frame headers (SOF0-SOF15 except DHT, JPG and DAC) carry height then width.
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return [view.getUint16(i + 7), view.getUint16(i + 5)];
    }
    i += 2 + view.getUint16(i + 2);
  }
  return undefined;
}

export function viewImageTool({ layout, files }: ViewImageDeps): Tool<typeof inputSchema> {
  return {
    name: "view_image",
    description:
      "Look at up to 4 image files you wrote (PNG or JPEG, at most 1 MiB and 2000 px a side each): they are returned as images, " +
      "in order, so you can check a render, an overlay or a plot. Only images; other files are refused. " +
      "Put several views on one sheet when you can. Only the images of your last two calls stay visible; older ones show as their text line, so call again to see one. " +
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
        const side = dimensions(bytes, mimeType);
        if (!side) throw new Error(`${path} has an unreadable image header`);
        if (Math.max(...side) > MAX_SIDE) {
          throw new Error(
            `${path} is ${side[0]} x ${side[1]} px: downscale it to at most ${MAX_SIDE} px a side`,
          );
        }
        const sha256 = createHash("sha256").update(bytes).digest("hex");
        images.push({ mimeType, data: bytes.toString("base64") });
        lines.push(
          `${path} (${mimeType}, ${side[0]} x ${side[1]} px, ${size} bytes, sha256 ${sha256})`,
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
