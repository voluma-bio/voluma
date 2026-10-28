/**
 * The Segmenter adapter for Meta's Model API (`sam-3.1`, Standard mode: content is not used
 * for training). One call is one multiplexed request: the stack is encoded as a lossless
 * H.264 video (default quality moves the masks; the slices are the frames, so frame `n` is
 * slice `n`), uploaded through the Files API, tracked both ways from the box prompts, and
 * the upload deleted afterwards. Needs `ffmpeg` on the runner's PATH. Meta's mask format,
 * and that masks come back cropped to their box, are in `one-bit-mask.ts` and the pasting
 * below.
 */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { openAsBlob } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Segmenter,
  SegmentObject,
  SegmentResult,
  SliceStack,
} from "@voluma/harness/ports/segmenter";
import { decodeOneBit } from "./one-bit-mask.ts";

const BASE = "https://api.meta.ai/v1";
/** Meta bills $0.20 per 1,000 video frames, at least 50 per request. */
const USD_PER_FRAME = 0.0002;
const MIN_FRAMES = 50;
const REQUEST_TIMEOUT_MS = 30 * 60_000;

export function metaSegmenter(options: {
  apiKey: string;
  log(line: string): void;
  /** Called with what Meta billed, as soon as it reports the frames (even if the call then fails). */
  addCost(usd: number): void;
}): Segmenter {
  const { apiKey, log, addCost } = options;
  const auth = { Authorization: `Bearer ${apiKey}` };
  return {
    async segment(stack, objects, signal) {
      const dir = await mkdtemp(join(tmpdir(), "sam-"));
      let fileId: string | undefined;
      try {
        const video = join(dir, "stack.mp4");
        const { width, height } = await encode(stack, video, signal);
        const prompt = promptText(objects, width, height);
        const upload = new FormData();
        upload.set("purpose", "user_data");
        upload.set("file", await openAsBlob(video, { type: "video/mp4" }), "stack.mp4");
        // Not the run's signal: an abort landing after Meta stored the file but before its
        // reply is read would leave the scan there with no id to delete. Honour it after.
        const uploaded = await fetch(`${BASE}/files`, {
          method: "POST",
          headers: auth,
          body: upload,
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        const reply = await uploaded.text();
        if (!uploaded.ok)
          throw new Error(`Meta upload failed: ${uploaded.status} ${reply.slice(0, 500)}`);
        fileId = (JSON.parse(reply) as { id?: string }).id;
        if (!fileId) {
          log("Meta stored an upload but its reply had no file id, so it cannot be deleted");
          throw new Error("Meta's upload reply had no file id");
        }
        signal.throwIfAborted();
        const text = await track(prompt, fileId, signal);
        return { ...paste(text, stack, objects, width, height), prompt };
      } finally {
        if (fileId) await deleteUpload(fileId);
        await rm(dir, { recursive: true, force: true });
      }
    },
  };

  /** The user's scan must not stay in Meta's file store: a failed delete is loud, not fatal. */
  async function deleteUpload(id: string) {
    const res = await fetch(`${BASE}/files/${id}`, {
      method: "DELETE",
      headers: auth,
      signal: AbortSignal.timeout(60_000),
    }).catch((e) => e as Error);
    if (res instanceof Error || !res.ok) {
      log(`Meta file ${id} was NOT deleted: ${res instanceof Error ? res.message : res.status}`);
    }
  }

  async function track(prompt: string, fileId: string, signal: AbortSignal) {
    const res = await fetch(`${BASE}/responses`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify({
        model: "sam-3.1",
        stream: true,
        metadata: { propagation_direction: "both", include_confidence: "true" },
        input: [
          {
            type: "message",
            role: "user",
            content: [
              { type: "input_text", text: prompt },
              { type: "input_video", file_id: fileId },
            ],
          },
        ],
      }),
      signal: withTimeout(signal),
    });
    if (!res.ok || !res.body) throw new Error(`Meta request failed: ${await failure(res)}`);
    let text = "";
    let pending = "";
    const decoder = new TextDecoder();
    for await (const chunk of res.body) {
      pending += decoder.decode(chunk, { stream: true });
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
        const event = JSON.parse(line.slice(6));
        if (event.type === "response.output_text.delta") text += event.delta;
        else if (event.type === "response.completed") {
          const frames: number = event.response?.usage?.video_frames_processed ?? 0;
          addCost(Math.max(frames, MIN_FRAMES) * USD_PER_FRAME);
        } else if (event.type === "error" || event.type === "response.failed") {
          throw new Error(`Meta request failed: ${JSON.stringify(event).slice(0, 500)}`);
        }
      }
    }
    return text;
  }
}

const withTimeout = (signal: AbortSignal) =>
  AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);

async function failure(res: Response): Promise<string> {
  return `${res.status} ${(await res.text()).slice(0, 500)}`;
}

/** `<frame>f` then `label<|box;x1;y1;x2;y2;w;h|>` for each box on that frame. */
function promptText(objects: SegmentObject[], width: number, height: number): string {
  const byFrame = new Map<number, string[]>();
  for (const { label, frame, box } of objects) {
    const [r0, c0, r1, c1] = box;
    const entry = `${label}<|box;x1=${c0};y1=${r0};x2=${c1};y2=${r1};w=${width};h=${height}|>`;
    byFrame.set(frame, [...(byFrame.get(frame) ?? []), entry]);
  }
  return [...byFrame]
    .sort(([a], [b]) => a - b)
    .map(([frame, entries]) => `<${frame}f>${entries.join(",")}`)
    .join("");
}

/**
 * Lossless H.264 (yuv420p wants even sides, so an odd stack gets a black edge; the boxes
 * keep their coordinates and the prompt carries the padded size). The child's exit is one
 * promise with its handlers attached before the first write, and every wait on the pipe
 * races it: an abort, a missing ffmpeg or an early exit rejects this call and nothing
 * else (an unhandled rejection ends the runner and every run on it).
 */
async function encode(stack: SliceStack, path: string, signal: AbortSignal) {
  const { data, count, height, width } = stack;
  const ffmpeg = spawn(
    "ffmpeg",
    [
      ...["-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "gray", "-s", `${width}x${height}`],
      ...["-r", "25", "-i", "-", "-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2", "-c:v", "libx264"],
      ...["-qp", "0", "-pix_fmt", "yuv420p", "-movflags", "+faststart", path],
    ],
    { stdio: ["pipe", "ignore", "pipe"], signal },
  );
  let stderr = "";
  ffmpeg.stderr.on("data", (d) => {
    stderr += d;
  });
  ffmpeg.stdin.on("error", () => {}); // the exit promise reports a dead ffmpeg
  const exited = new Promise<number>((resolve, reject) => {
    ffmpeg.once("error", (e: NodeJS.ErrnoException) =>
      reject(
        e.code === "ENOENT"
          ? new Error("ffmpeg is not installed on the runner host (not on PATH)")
          : e,
      ),
    );
    ffmpeg.once("close", (code) => resolve(code ?? -1));
  });
  let code: number | undefined;
  exited.then(
    (c) => {
      code = c;
    },
    () => {},
  );
  try {
    const slice = height * width;
    for (let f = 0; f < count && code === undefined; f++) {
      if (!ffmpeg.stdin.write(data.subarray(f * slice, (f + 1) * slice))) {
        await Promise.race([once(ffmpeg.stdin, "drain").catch(() => {}), exited]);
      }
    }
    ffmpeg.stdin.end();
    code = await exited;
  } catch (error) {
    ffmpeg.kill();
    throw error;
  }
  if (code !== 0) throw new Error(`ffmpeg failed (${code}): ${stderr.slice(0, 500)}`);
  return { width: width + (width % 2), height: height + (height % 2) };
}

const RECORD = /(\d+)<\|box;([^|]*)\|><\|mask;([^|]*)\|>/g;
const field = (fields: string, name: string) =>
  new RegExp(`(?:^|;)${name}=([^;]*)`).exec(fields)?.[1];
const num = (fields: string, name: string) => {
  const value = Number(field(fields, name));
  if (Number.isNaN(value)) throw new Error(`the response record has no ${name}`);
  return value;
};

/**
 * The response is text: `<frame>f` markers (in no fixed order) each followed by one
 * `id<|box|><|mask|>` record per object seen there. A mask is cropped to its box, so it
 * is pasted at the box's corner; objects keep the ids the prompt gave them. Anything that
 * is not what every saved response has (the frame size we sent, a mask at the origin and
 * the size of its box) throws, because pasting it anyway would misplace the labels
 * without a sign. Confidence is per object and frame, from the mask token.
 */
function paste(
  text: string,
  stack: SliceStack,
  objects: SegmentObject[],
  paddedWidth: number,
  paddedHeight: number,
): Pick<SegmentResult, "labels" | "confidence"> {
  const { count, height, width } = stack;
  const known = new Set(objects.map((o) => o.label));
  const labels = new Uint8Array(count * height * width);
  const confidence: SegmentResult["confidence"] = {};
  for (const part of text.split(/(?=<\d+f>)/)) {
    const frame = /^<(\d+)f>/.exec(part)?.[1];
    if (frame === undefined) continue;
    if (Number(frame) >= count)
      throw new Error(`the response has slice ${frame}, past the ${count} sent`);
    const base = Number(frame) * height * width;
    for (const [, id = "", box = "", mask = ""] of part.matchAll(RECORD)) {
      const label = Number(id);
      if (!known.has(label))
        throw new Error(`the response names object ${id}, which was not prompted`);
      if (num(box, "w") !== paddedWidth || num(box, "h") !== paddedHeight) {
        throw new Error("the response is for a frame size other than the one sent");
      }
      const x1 = num(box, "x1");
      const y1 = num(box, "y1");
      const boxW = num(box, "x2") - x1 + 1;
      const boxH = num(box, "y2") - y1 + 1;
      const [h, w, encoded] = /^(\d+),(\d+),(.*)$/s.exec(field(mask, "data") ?? "")?.slice(1) ?? [];
      if (encoded === undefined || !encoded.startsWith("!")) {
        throw new Error("the response has a mask that is not one_bit");
      }
      if (
        num(mask, "x") !== 0 ||
        num(mask, "y") !== 0 ||
        Number(w) !== boxW ||
        Number(h) !== boxH
      ) {
        throw new Error("the response has a mask that is not at the origin of its own box");
      }
      const bits = decodeOneBit(encoded.slice(1), boxW, boxH);
      for (let i = 0; i < boxH; i++) {
        const y = y1 + i;
        if (y < 0 || y >= height) continue;
        for (let j = 0; j < boxW; j++) {
          const x = x1 + j;
          if (x < 0 || x >= width) continue;
          const at = base + y * width + x;
          if (bits[i * boxW + j] && labels[at] === 0) labels[at] = label;
        }
      }
      const perFrame = confidence[label] ?? {};
      perFrame[Number(frame)] = num(mask, "c");
      confidence[label] = perFrame;
    }
  }
  return { labels, confidence };
}
