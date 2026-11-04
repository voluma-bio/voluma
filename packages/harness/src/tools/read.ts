/**
 * The agent loop's `read`: up to 4 files of the run's mounts in one call, text or images, read
 * host-side through the thread's layout so no sandbox starts. Text comes back whole up to
 * MAX_LINES lines or MAX_CHARS characters; past that the reply ends on a line boundary with the
 * `offset` to read on from, so nothing is cut silently or mid-line. A PNG or JPEG is shown to the
 * model; one over the image limits (`image-fit.ts`) is cut at the panes its `.view.json` sidecar
 * names (`quad_view.py` writes one), else downscaled. The `tool.result` event keeps the text only:
 * each file's path, size and hash.
 */
import { createHash } from "node:crypto";
import sharp from "sharp";
import { z } from "zod";
import type { ThreadLayout } from "../layout";
import type { RunBucket } from "../ports/bucket";
import { downscale, MAX_BYTES, MAX_SIDE } from "./image-fit";
import { readWhole } from "./read-whole";
import type { Tool, ToolResult } from "./tool";

const MAX_PATHS = 4;
const MAX_LINES = 2000;
const MAX_CHARS = 100_000;
// What is fetched before it is paged or downscaled; a bigger file is not one anyone reads whole.
const MAX_READ_BYTES = 64 * 1024 * 1024;

const inputSchema = z.object({
  paths: z
    .array(z.string())
    .min(1)
    .max(MAX_PATHS)
    .describe(
      `Up to ${MAX_PATHS} files, text or PNG/JPEG images, in the order to show them. A relative path is read from your working folder.`,
    ),
  offset: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("The line to start at, to read on in one long text file; give it with one path."),
});

const isPng = (b: Buffer) => b.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
const isJpeg = (b: Buffer) => b.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]));
/** NUL bytes or numpy's magic: control bytes the model would get as noise. */
const isBinary = (b: Buffer) =>
  b.includes(0) || b.subarray(0, 6).equals(Buffer.from("\x93NUMPY", "latin1"));

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/** A page of `text` from line `offset`, ending on a line boundary, with the note to read on. */
function page(path: string, text: string, offset: number): string {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (offset > lines.length && !(offset === 1 && lines.length === 0))
    throw new Error(`${path} has ${lines.length} lines; offset ${offset} is past its end`);
  let end = offset - 1;
  let chars = 0;
  while (end < lines.length && end - (offset - 1) < MAX_LINES) {
    const next = chars + (lines[end] as string).length + 1;
    if (next > MAX_CHARS && end > offset - 1) break;
    chars = next;
    end++;
  }
  const body = lines
    .slice(offset - 1, end)
    .join("\n")
    .slice(0, MAX_CHARS);
  if (end >= lines.length && offset === 1) return body;
  const next =
    end < lines.length ? `; read again with offset ${end + 1} for the rest` : " (the end)";
  return `${body}\n[lines ${offset}-${end} of ${lines.length}${next}]`;
}

interface Piece {
  label?: string;
  bytes: Buffer;
  mimeType: string;
  width: number;
  height: number;
}

/** The sidecar's panes, 3D first: [label, [x0, y0, x1, y1]]. None when there is no usable sidecar. */
async function panesOf(
  read: (path: string) => Promise<Buffer>,
  path: string,
): Promise<[string, number[]][]> {
  let view: unknown;
  try {
    view = JSON.parse((await read(`${path.replace(/\.[^./]+$/, "")}.view.json`)).toString());
  } catch {
    return [];
  }
  const parsed = z
    .object({
      "3d": z.object({ rect: z.array(z.number()).length(4) }).optional(),
      panes: z
        .array(z.object({ name: z.string(), rect: z.array(z.number()).length(4) }))
        .default([]),
    })
    .safeParse(view);
  if (!parsed.success) return [];
  const { "3d": three, panes } = parsed.data;
  return [
    ...(three ? [["3D", three.rect] as [string, number[]]] : []),
    ...panes.map((p): [string, number[]] => [p.name, p.rect]),
  ];
}

/** An image as the model sees it: itself, or its panes in order, or a downscaled copy. */
async function piecesOf(
  bytes: Buffer,
  path: string,
  read: (path: string) => Promise<Buffer>,
): Promise<{ pieces: Piece[]; note: string }> {
  const meta = await sharp(bytes).metadata();
  const { width, height } = meta.autoOrient;
  const fits = bytes.length <= MAX_BYTES && Math.max(width, height) <= MAX_SIDE;
  const mimeType = `image/${meta.format}`;
  if (fits) return { pieces: [{ bytes, mimeType, width, height }], note: "" };
  const fit = async (buf: Buffer, label?: string): Promise<Piece> => {
    const m = await sharp(buf).metadata();
    const { width: w, height: h } = m.autoOrient;
    if (buf.length <= MAX_BYTES && Math.max(w, h) <= MAX_SIDE)
      return { label, bytes: buf, mimeType: `image/${m.format}`, width: w, height: h };
    return { label, mimeType: "image/jpeg", ...(await downscale(buf, w, h)) };
  };
  const panes = await panesOf(read, path);
  if (panes.length > 0) {
    const pieces: Piece[] = [];
    for (const [label, [x0, y0, x1, y1]] of panes) {
      const crop = await sharp(bytes)
        .autoOrient()
        .extract({
          left: x0 as number,
          top: y0 as number,
          width: (x1 as number) - (x0 as number),
          height: (y1 as number) - (y0 as number),
        })
        .png()
        .toBuffer();
      pieces.push(await fit(crop, label));
    }
    return {
      pieces,
      note: `cut at its ${pieces.length} panes (${width} x ${height} px, ${bytes.length} bytes)`,
    };
  }
  return {
    pieces: [await fit(bytes)],
    note: `downscaled from ${width} x ${height} px, ${bytes.length} bytes`,
  };
}

export function readTool({
  layout,
  bucket,
  hasSandbox,
}: {
  layout: ThreadLayout;
  bucket: RunBucket;
  /** A role with bash can also read its sandbox's own files (`/tmp`). */
  hasSandbox: boolean;
}): Tool<typeof inputSchema> {
  return {
    name: "read",
    description:
      `Read up to ${MAX_PATHS} files in one call, text or PNG/JPEG images, without starting a sandbox. ` +
      `Text comes back whole up to ${MAX_LINES} lines or ${MAX_CHARS} characters; a longer file ends with the offset to read on from. ` +
      "Images come back as images you see (an image over 1 MiB or 2000 px a side is cut at the panes its .view.json names, or downscaled), so open several views side by side in one call. " +
      "Use it for skills, notes, results and renders; bash output stays text. " +
      layout.description,
    input: inputSchema,
    async execute({ paths, offset }, ctx) {
      if (offset !== undefined && paths.length > 1)
        throw new Error("offset reads on in one file: give one path with it");
      const read = (path: string) =>
        readWhole(
          { layout, bucket, sandbox: hasSandbox ? ctx.sandbox : undefined },
          path,
          MAX_READ_BYTES,
          ctx.signal,
        );
      const images: NonNullable<ToolResult["images"]> = [];
      const sections: string[] = [];
      let failed = 0;
      for (const named of paths) {
        const path = layout.resolve(named);
        try {
          const bytes = await read(path);
          if (isPng(bytes) || isJpeg(bytes)) {
            const { pieces, note } = await piecesOf(bytes, path, read);
            if (images.length + pieces.length > MAX_PATHS)
              throw new Error(
                `${path} would show ${pieces.length} images and a call shows at most ${MAX_PATHS}: read it alone`,
              );
            for (const p of pieces)
              images.push({ mimeType: p.mimeType, data: p.bytes.toString("base64") });
            sections.push(
              pieces
                .map(
                  (p) =>
                    `Image: ${path}${p.label ? ` (${p.label})` : ""}, ${p.mimeType}, ${p.width} x ${p.height} px, sha256 ${sha(p.bytes)}`,
                )
                .join("\n") + (note ? `\n[${note}]` : ""),
            );
            continue;
          }
          if (isBinary(bytes))
            throw new Error(
              `${path} is binary: ${hasSandbox ? "read an array with python through bash" : "it is not a text file or a PNG/JPEG image"}`,
            );
          const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
          sections.push(`${path}:\n${page(path, text, offset ?? 1)}`);
        } catch (error) {
          failed++;
          sections.push(`${path}: ${error instanceof Error ? error.message : error}`);
        }
      }
      return {
        output: sections.join("\n\n"),
        isError: failed === paths.length,
        truncated: false,
        ...(images.length > 0 && { images }),
      };
    },
  };
}
