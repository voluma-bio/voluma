/**
 * How a reply reports what it cost. The gateway feeds this each line of the reply as it passes
 * (a line of an SSE stream, or the whole of a JSON reply), already cut to its last 64 KB if it
 * was longer, so the numbers are read by pattern, not by parsing. A pattern must be tied to
 * the unescaped `"usage":{` (text a model wrote inside a string has its quotes escaped), and
 * the last one wins: Anthropic's `message_start` carries the input, its `message_delta` the
 * final output, and Responses' `response.completed` all of it.
 */
import type { Observed } from "./prices";

const USAGE = /"usage":\{/g;
const INTEGER = (key: string) => new RegExp(`"${key}":(\\d+)`, "g");
const FIELDS = {
  inputTokens: INTEGER("input_tokens"),
  outputTokens: INTEGER("output_tokens"),
  cacheReadTokens: INTEGER("(?:cache_read_input_tokens|cached_tokens)"),
  cacheWriteTokens: INTEGER("cache_creation_input_tokens"),
} satisfies Record<string, RegExp>;
const FRAMES = INTEGER("video_frames_processed");
const FILE_ID = /"id":"([^"]+)"/;

/** The last capture of `pattern` in `text`, or undefined. */
function lastInt(pattern: RegExp, text: string): number | undefined {
  let found: number | undefined;
  for (const m of text.matchAll(pattern)) found = Number(m[1]);
  return found;
}

/** Adds what `line` reports to `seen`. */
export function observeLine(line: string, seen: Observed): void {
  const frames = line.includes("video_frames_processed") ? lastInt(FRAMES, line) : undefined;
  if (frames !== undefined) seen.frames = frames;
  let from = -1;
  for (const m of line.matchAll(USAGE)) from = m.index;
  if (from < 0) return;
  const usage = line.slice(from);
  for (const [field, pattern] of Object.entries(FIELDS)) {
    const value = lastInt(pattern, usage);
    if (value !== undefined) seen[field as keyof typeof FIELDS] = value;
  }
}

/** The id an upload's reply names (`{"id":"file_…"}`), or undefined. */
export const fileIdOf = (line: string): string | undefined => FILE_ID.exec(line)?.[1];
