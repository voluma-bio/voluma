/**
 * A closed worker's conversation as `/work/<name>/transcript.md`, written from its stored
 * history when a worker is started `from` it. A reader searches the file when the wrap-up note
 * is thin, so a long message or tool result is cut and thinking and images are left out.
 */

import { workPrefix } from "@voluma/contracts/r2";
import { foldHistory } from "./adapters/pi/compaction";
import type { RunBucket } from "./ports/bucket";
import type { History } from "./ports/history";

const RESULT_CHARS = 2_000;
const MESSAGE_CHARS = 3_000;
const CALL_CHARS = 1_000;
const FILE_CHARS = 400_000;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}… (cut)` : s);

type Block = { type: string; text?: string; name?: string; arguments?: unknown };

const textOf = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? (content as Block[])
          .filter((b) => b.type === "text")
          .map((b) => b.text)
          .join("\n")
      : "";

export function renderTranscript(rows: string[]): string {
  const parts: string[] = [];
  for (const m of foldHistory(rows).messages) {
    const { content } = m as { content?: unknown };
    switch (m.role) {
      case "user":
        parts.push(`## Message to it\n\n${clip(textOf(content), MESSAGE_CHARS)}`);
        break;
      case "assistant": {
        const blocks = Array.isArray(content) ? (content as Block[]) : [];
        const lines = blocks.flatMap((b) =>
          b.type === "text"
            ? [clip(b.text ?? "", MESSAGE_CHARS)]
            : b.type === "toolCall"
              ? [`Tool call ${b.name}: ${clip(JSON.stringify(b.arguments), CALL_CHARS)}`]
              : [],
        );
        if (lines.length > 0) parts.push(`## It\n\n${lines.join("\n\n")}`);
        break;
      }
      case "toolResult":
        parts.push(`## Result\n\n${clip(textOf(content), RESULT_CHARS)}`);
        break;
    }
  }
  const body = parts.join("\n\n");
  // Keep the end: the closing turns matter most.
  const text =
    body.length > FILE_CHARS
      ? `(The start is cut: the transcript kept its last ${FILE_CHARS} characters.)\n\n${body.slice(-FILE_CHARS)}`
      : body;
  return `# Transcript\n\n${text}\n`;
}

/** Loads and renders the history now; the returned function writes the file. */
export async function prepareTranscript(o: {
  history: History;
  bucket: RunBucket;
  runId: string;
  agent: { id: string; name: string };
  signal: AbortSignal;
}): Promise<() => Promise<void>> {
  const body = Buffer.from(renderTranscript(await o.history.load(o.agent.id)));
  return () =>
    o.bucket.write(`${workPrefix(o.runId)}${o.agent.name}/transcript.md`, body, o.signal);
}
