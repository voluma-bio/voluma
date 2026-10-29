/**
 * The Segmenter adapter for Meta's Model API (`sam-3.1`, Standard mode: content is not used
 * for training). One call is one multiplexed request: the stack is encoded as a lossless
 * H.264 video (default quality moves the masks; the slices are the frames, so frame `n` is
 * slice `n`), uploaded through the Files API, tracked both ways from the box prompts, and
 * the upload deleted afterwards. Needs `ffmpeg` on the runner's PATH. Meta's mask format,
 * and that masks come back cropped to their box, are in `sam-mask.ts` and the pasting
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
import { decodeMask } from "./sam-mask.ts";

const BASE = "https://api.meta.ai/v1";
/** Meta bills $0.20 per 1,000 video frames, at least 50 per request. */
const USD_PER_FRAME = 0.0002;
const MIN_FRAMES = 50;
const REQUEST_TIMEOUT_MS = 30 * 60_000;

export function metaSegmenter(options: {
  apiKey: string;
  log(line: string): void;
  /**
   * The run's meter, called with what Meta billed as soon as it reports the frames (even if
   * the call then fails); the call's own `bill` gets the same amount for its `tool.result`.
   */
  addCost(usd: number): void;
  /**
   * Stores a response that could not be pasted, since Meta bills it and the sandbox's local
   * disk is lost; resolves to where a person can read it.
   */
  keepFailed(text: string): Promise<string>;
}): Segmenter {
  const { apiKey, log, addCost, keepFailed } = options;
  const auth = { Authorization: `Bearer ${apiKey}` };
  return {
    async segment(stack, objects, signal, bill) {
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
        const text = await track(prompt, objects, fileId, signal, bill);
        try {
          return { ...paste(text, stack, objects, width, height), prompt };
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          const kept = await keepFailed(text).catch((e) => `not kept (${e})`);
          throw new Error(`${detail}; Meta's response: ${kept}`, { cause: error });
        }
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

  async function track(
    prompt: string,
    objects: SegmentObject[],
    fileId: string,
    signal: AbortSignal,
    bill: (usd: number) => void,
  ) {
    const started = Date.now();
    const request = () =>
      fetch(`${BASE}/responses`, {
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
    let res = await request();
    // Meta answers `404 model_not_found` for some prompts (a small box), not only for an outage,
    // and bills nothing for it. Once more on the uploaded file costs nothing if it fails again.
    if (res.status === 404) {
      log(`Meta answered 404 to a SAM request: ${await failure(res)}; trying once more`);
      res = await request();
    }
    if (res.status === 404) {
      const asked = objects
        .map((o) => `"${o.name}" (label ${o.label}, frame ${o.frame}, box [${o.box}])`)
        .join("; ");
      throw new Error(
        `Meta answered 404 model_not_found twice to this request. It does this for some inputs, ` +
          `not only when the service is down, and bills nothing for it. Asked for: ${asked}. ` +
          `Likely one object's box prompt is the cause (a small box often is); try fewer objects ` +
          `per call, or change or drop the one that keeps failing. A failing call costs nothing; ` +
          `a call that succeeds costs about $0.07-0.10.`,
      );
    }
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
          const usd = Math.max(frames, MIN_FRAMES) * USD_PER_FRAME;
          addCost(usd);
          bill(usd);
          log(
            `SAM call: ${frames} frames, $${usd.toFixed(4)} added to the run's cost, ${Math.round((Date.now() - started) / 1000)} s`,
          );
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
        throw new Error(
          `the response is for a frame size other than the one sent (slice ${frame}, object ${id})`,
        );
      }
      const x1 = num(box, "x1");
      const y1 = num(box, "y1");
      const boxW = num(box, "x2") - x1 + 1;
      const boxH = num(box, "y2") - y1 + 1;
      if (
        boxW <= 0 ||
        boxH <= 0 ||
        x1 < 0 ||
        y1 < 0 ||
        !Number.isInteger(x1) ||
        !Number.isInteger(y1) ||
        x1 + boxW > paddedWidth ||
        y1 + boxH > paddedHeight
      ) {
        throw new Error(`the response has a box outside the frame (slice ${frame}, object ${id})`);
      }
      const [h, w, encoded] = /^(\d+),(\d+),(.*)$/s.exec(field(mask, "data") ?? "")?.slice(1) ?? [];
      if (encoded === undefined) {
        throw new Error(`the response mask has no payload (slice ${frame}, object ${id})`);
      }
      if (
        num(mask, "x") !== 0 ||
        num(mask, "y") !== 0 ||
        Number(w) !== boxW ||
        Number(h) !== boxH
      ) {
        throw new Error(
          `the response has a mask that is not at the origin of its own box (slice ${frame}, object ${id})`,
        );
      }
      let bits: Uint8Array;
      try {
        bits = decodeMask(encoded, boxW, boxH);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(
          `the response mask failed to decode (slice ${frame}, object ${id}, encoding ${encoded[0] ?? "none"}, ${h}x${w}): ${detail}`,
        );
      }
      for (let i = 0; i < boxH; i++) {
        const y = y1 + i;
        if (y >= height) continue;
        for (let j = 0; j < boxW; j++) {
          const x = x1 + j;
          if (x >= width) continue;
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
