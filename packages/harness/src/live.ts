/**
 * Live frames (`@voluma/contracts/stream`): the model's output as it is written, sent to the
 * API as it happens and never stored. Two parts:
 * - `LiveBatcher` coalesces frames and posts them in batches, one request at a time and at
 *   most every FLUSH_MS. It never blocks the model: a frame is dropped when the
 *   unacknowledged text is over MAX_BUFFER_CHARS (the API is slow or down), and a failed post is
 *   dropped, not retried. A dropped frame leaves a gap in `offset`, which the browser's
 *   append guard turns into "stop showing this partial"; the durable event still lands.
 * - `ReplyFrames` turns one assistant reply's pi-ai events into frames, owning the
 *   `offset` of each text, reasoning and tool-argument string.
 * A frame is redacted as a whole, so a secret split across two frames is not caught.
 */
import type { AssistantMessageEvent } from "@earendil-works/pi-ai";
import { type LiveFrame, liveFrameSchema } from "@voluma/contracts/stream";

type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;
/** A frame before the recorder adds the run id. */
export type LiveBody = DistributiveOmit<LiveFrame, "runId">;

const FLUSH_MS = 80;
const MAX_BUFFER_CHARS = 256 * 1024;
const MAX_BATCH = 1000; // the API route's limit

/** Where batches go; the HTTP client's `live` call. Failures are dropped. */
export type PostLive = (frames: LiveFrame[]) => Promise<void>;

export interface LiveBatcher {
  push(frame: LiveFrame): void;
  /** Sends what is buffered and waits for it; call at the end of a run. */
  flush(): Promise<void>;
  /** Counters since the start, for measuring. */
  stats(): { frames: number; requests: number; dropped: number };
}

/** Frames of one stream of text: the same type, thread and reply, call or output stream. */
const streamKey = (f: LiveFrame) =>
  f.type === "tool.output"
    ? `${f.type}|${f.threadId}|${f.toolCallId}|${f.stream}`
    : f.type === "tool.arguments.delta"
      ? `${f.type}|${f.threadId}|${f.messageId}|${f.toolCallId}`
      : `${f.type}|${f.threadId}|${f.messageId}`;

/** Appends `next` to `prev` when it continues it (an output chunk always does; a delta must start where `prev` ends). */
function merge(prev: LiveFrame, next: LiveFrame): boolean {
  if (prev.type === "tool.output") {
    prev.text += next.type === "tool.output" ? next.text : "";
    return true;
  }
  if (next.type === "tool.output" || prev.offset + prev.text.length !== next.offset) return false;
  prev.text += next.text;
  return true;
}

export function liveBatcher(post: PostLive): LiveBatcher {
  const buffer: LiveFrame[] = [];
  let lastOf = new Map<string, LiveFrame>(); // the buffered frame each stream continues
  let chars = 0; // text not yet acknowledged by the API: buffered, or in a post
  let timer: ReturnType<typeof setTimeout> | undefined;
  let posting: Promise<void> | undefined;
  const counts = { frames: 0, requests: 0, dropped: 0 };

  // One post at a time: while one is out, frames keep merging into the buffer.
  const send = () => {
    timer = undefined;
    if (posting || buffer.length === 0) return;
    const batch = buffer.splice(0, MAX_BATCH);
    lastOf = new Map(buffer.map((f) => [streamKey(f), f]));
    const size = batch.reduce((n, f) => n + ("text" in f ? f.text.length : 0), 0);
    counts.requests++;
    // A frame the API would refuse would sink the whole batch, so none goes out invalid.
    const valid = batch.filter((f) => liveFrameSchema.safeParse(f).success);
    posting = post(valid)
      .catch(() => {})
      .finally(() => {
        chars -= size;
        posting = undefined;
        if (buffer.length > 0) timer ??= setTimeout(send, FLUSH_MS);
      });
  };

  return {
    push(frame) {
      counts.frames++;
      // Never wait for the API: past the cap, drop.
      if (chars >= MAX_BUFFER_CHARS) {
        counts.dropped++;
        return;
      }
      chars += "text" in frame ? frame.text.length : 0;
      const key = streamKey(frame);
      const prev = lastOf.get(key);
      if (!prev || !merge(prev, frame)) {
        const copy = { ...frame };
        buffer.push(copy);
        lastOf.set(key, copy);
      }
      timer ??= setTimeout(send, FLUSH_MS);
    },
    async flush() {
      if (timer) clearTimeout(timer);
      while (buffer.length > 0 || posting) {
        send();
        await posting;
      }
    },
    stats: () => ({ ...counts }),
  };
}

/**
 * Frames for one assistant reply. A reply's text blocks join into one string (as the
 * durable `message` text does), so `offset` counts across them; reasoning likewise; each
 * tool call's arguments have their own. Tool-call ids come from the partial message.
 */
export function replyFrames(
  threadId: string,
  messageId: string,
  push: (body: LiveBody) => void,
): (event: AssistantMessageEvent) => void {
  let textLen = 0;
  let reasoningLen = 0;
  const argsLen = new Map<string, number>();
  return (event) => {
    switch (event.type) {
      case "text_delta":
        push({ type: "text.delta", threadId, messageId, offset: textLen, text: event.delta });
        textLen += event.delta.length;
        break;
      case "thinking_delta":
        push({
          type: "reasoning.delta",
          threadId,
          messageId,
          offset: reasoningLen,
          text: event.delta,
        });
        reasoningLen += event.delta.length;
        break;
      case "toolcall_delta": {
        const block = event.partial.content[event.contentIndex];
        if (block?.type !== "toolCall") break;
        const toolCallId = block.id;
        if (!toolCallId) break; // some providers send the id after the first arguments
        const offset = argsLen.get(toolCallId) ?? 0;
        push({
          type: "tool.arguments.delta",
          threadId,
          messageId,
          toolCallId,
          offset,
          text: event.delta,
        });
        argsLen.set(toolCallId, offset + event.delta.length);
        break;
      }
    }
  };
}
