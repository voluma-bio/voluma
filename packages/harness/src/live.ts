/**
 * Live frames (`@voluma/contracts/stream`): the model's output as it is written, sent to the
 * API as it happens and never stored. Two parts:
 * - `LiveBatcher` coalesces frames and posts them in batches, per thread, at most every
 *   FLUSH_MS, one request at a time. It never blocks the model: a frame is dropped when the
 *   unacknowledged text is over MAX_BUFFER_CHARS (the API is slow or down), and a failed post is
 *   dropped, not retried. A dropped frame leaves a gap in `offset`, which the browser's
 *   append guard turns into "stop showing this partial"; the durable event still lands.
 * - `ReplyFrames` turns one assistant reply's pi-ai events into frames, owning the
 *   `offset` of each text, reasoning and tool-argument string.
 * A frame is redacted as a whole, so a secret split across two frames is not caught.
 */
import type { AssistantMessageEvent } from "@earendil-works/pi-ai";
import type { LiveFrame } from "@voluma/contracts/stream";

type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;
/** A frame before the recorder adds the run id. */
export type LiveBody = DistributiveOmit<LiveFrame, "runId">;

const FLUSH_MS = 80;
const MAX_BUFFER_CHARS = 256 * 1024;

/** Where batches go; the HTTP client's `live` call. Failures are dropped. */
export type PostLive = (frames: LiveFrame[]) => Promise<void>;

export interface LiveBatcher {
  push(frame: LiveFrame): void;
  /** Sends what is buffered and waits for it; for tests and the end of a run. */
  flush(): Promise<void>;
  /** Counters since the start, for measuring. */
  stats(): { frames: number; requests: number; dropped: number };
}

/** Frames that continue each other: same type and key, and the later one starts where the earlier ends. */
function merge(prev: LiveFrame | undefined, next: LiveFrame): boolean {
  if (!prev || prev.type !== next.type || prev.threadId !== next.threadId) return false;
  if (prev.type === "tool.output" && next.type === "tool.output") {
    if (prev.toolCallId !== next.toolCallId || prev.stream !== next.stream) return false;
    prev.text += next.text;
    return true;
  }
  if (
    (prev.type === "text.delta" || prev.type === "reasoning.delta") &&
    (next.type === "text.delta" || next.type === "reasoning.delta") &&
    prev.messageId === next.messageId &&
    prev.offset + prev.text.length === next.offset
  ) {
    prev.text += next.text;
    return true;
  }
  if (
    prev.type === "tool.arguments.delta" &&
    next.type === "tool.arguments.delta" &&
    prev.messageId === next.messageId &&
    prev.toolCallId === next.toolCallId &&
    prev.offset + prev.text.length === next.offset
  ) {
    prev.text += next.text;
    return true;
  }
  return false;
}

export function liveBatcher(post: PostLive): LiveBatcher {
  let buffer: LiveFrame[] = [];
  let chars = 0; // text not yet acknowledged by the API: buffered, or in a post
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> = Promise.resolve();
  const counts = { frames: 0, requests: 0, dropped: 0 };

  const send = () => {
    timer = undefined;
    if (buffer.length === 0) return;
    const batch = buffer;
    buffer = [];
    const size = batch.reduce((n, f) => n + ("text" in f ? f.text.length : 0), 0);
    counts.requests++;
    inFlight = inFlight.then(() =>
      post(batch)
        .catch(() => {})
        .finally(() => {
          chars -= size;
        }),
    );
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
      if (!merge(buffer.at(-1), frame)) buffer.push({ ...frame });
      timer ??= setTimeout(send, FLUSH_MS);
    },
    async flush() {
      if (timer) clearTimeout(timer);
      send();
      await inFlight;
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
