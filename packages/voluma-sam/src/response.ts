/**
 * Meta's reply, saved to a file as it arrives and read back here in one linear pass: lines are
 * cut from raw chunks (a line can be 100+ MB; re-splitting a growing buffer per chunk is
 * quadratic), the text deltas are scanned for complete records as they come, and each mask is
 * decoded and pasted at once. Nothing is held but the line being parsed and the labels.
 *
 * The text is `<frame>f` markers (in no fixed order) each followed by one `id<|box|><|mask|>`
 * record per object seen there. A mask is cropped to its box, so it is pasted at the box's
 * corner; objects keep the ids the prompt gave them. Anything that is not what every saved
 * response has (the frame size we sent, a mask at the origin and the size of its box) throws,
 * because pasting it anyway would misplace the labels without a sign.
 */
import { createReadStream } from "node:fs";
import { Failure } from "./meta";
import { decodeMask } from "./sam-mask";

/** Lines of the file, without the newline. */
async function* lines(path: string): AsyncGenerator<string> {
  let parts: Buffer[] = [];
  for await (const chunk of createReadStream(path, {
    highWaterMark: 1 << 20,
  }) as AsyncIterable<Buffer>) {
    let from = 0;
    for (let nl = chunk.indexOf(10, from); nl >= 0; nl = chunk.indexOf(10, from)) {
      parts.push(chunk.subarray(from, nl));
      yield Buffer.concat(parts).toString();
      parts = [];
      from = nl + 1;
    }
    if (from < chunk.length) parts.push(chunk.subarray(from));
  }
  if (parts.length) yield Buffer.concat(parts).toString();
}

const TOKEN = /<(\d+)f>|(\d+)<\|box;([^|]*)\|><\|mask;([^|]*)\|>/g;
const field = (fields: string, name: string) =>
  new RegExp(`(?:^|;)${name}=([^;]*)`).exec(fields)?.[1];
const num = (fields: string, name: string) => {
  const value = Number(field(fields, name));
  if (Number.isNaN(value)) throw new Error(`the response record has no ${name}`);
  return value;
};

export interface PasteTarget {
  /** Slices the crop holds. */
  count: number;
  /** The crop's slice size. */
  height: number;
  width: number;
  /** The size the prompt claimed (even sides). */
  paddedWidth: number;
  paddedHeight: number;
  known: Set<number>;
  /** Steps in `labels` along a slice, a row and a column. */
  strides: [number, number, number];
  labels: Uint8Array;
}

export interface Pasted {
  /** `confidence[label][frame]`, frames the crop's own. */
  confidence: Record<number, Record<number, number>>;
  frames: number;
  responseId: string | undefined;
}

export async function pasteResponse(path: string, target: PasteTarget): Promise<Pasted> {
  const confidence: Pasted["confidence"] = {};
  let frames = 0;
  let responseId: string | undefined;
  let completed = false;
  let rest = "";
  let frame: number | undefined;
  for await (const line of lines(path)) {
    if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
    const event = JSON.parse(line.slice(6));
    if (event.type === "response.output_text.delta") {
      const text = rest + event.delta;
      TOKEN.lastIndex = 0;
      let end = 0;
      for (let m = TOKEN.exec(text); m; m = TOKEN.exec(text)) {
        end = TOKEN.lastIndex;
        if (m[1] !== undefined) {
          frame = Number(m[1]);
          if (frame >= target.count)
            throw new Error(`the response has slice ${frame}, past the ${target.count} sent`);
        } else {
          if (frame === undefined) throw new Error("the response has a record before any slice");
          pasteRecord(target, confidence, frame, m[2] ?? "", m[3] ?? "", m[4] ?? "");
        }
      }
      rest = text.slice(end);
    } else if (event.type === "response.completed") {
      completed = true;
      frames = event.response?.usage?.video_frames_processed ?? 0;
      responseId = event.response?.id;
    } else if (event.type === "error" || event.type === "response.failed") {
      throw new Error(`Meta request failed: ${JSON.stringify(event).slice(0, 500)}`);
    }
  }
  // A body closed early (a proxy timeout, a gateway that ends the stream) parses cleanly but
  // leaves slices out.
  if (!completed)
    throw new Failure("Meta's reply ended before response.completed: it is cut short", true);
  if (rest.trim()) throw new Error("the response ends in the middle of a record");
  return { confidence, frames, responseId };
}

function pasteRecord(
  t: PasteTarget,
  confidence: Pasted["confidence"],
  frame: number,
  id: string,
  box: string,
  mask: string,
) {
  const label = Number(id);
  if (!t.known.has(label))
    throw new Error(`the response names object ${id}, which was not prompted`);
  if (num(box, "w") !== t.paddedWidth || num(box, "h") !== t.paddedHeight) {
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
    x1 + boxW > t.paddedWidth ||
    y1 + boxH > t.paddedHeight
  ) {
    throw new Error(`the response has a box outside the frame (slice ${frame}, object ${id})`);
  }
  const [h, w, encoded] = /^(\d+),(\d+),(.*)$/s.exec(field(mask, "data") ?? "")?.slice(1) ?? [];
  if (encoded === undefined) {
    throw new Error(`the response mask has no payload (slice ${frame}, object ${id})`);
  }
  if (num(mask, "x") !== 0 || num(mask, "y") !== 0 || Number(w) !== boxW || Number(h) !== boxH) {
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
  const [sf, sy, sx] = t.strides;
  for (let i = 0; i < boxH; i++) {
    const y = y1 + i;
    if (y >= t.height) continue;
    const row = frame * sf + y * sy;
    for (let j = 0; j < boxW; j++) {
      const x = x1 + j;
      if (x >= t.width) continue;
      const at = row + x * sx;
      if (bits[i * boxW + j] && t.labels[at] === 0) t.labels[at] = label;
    }
  }
  const perFrame = confidence[label] ?? {};
  perFrame[frame] = num(mask, "c");
  confidence[label] = perFrame;
}
