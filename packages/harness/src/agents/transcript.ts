/**
 * A closed worker's conversation as `/work/<name>/transcript.md`, written from its stored
 * History when a worker is started `from` it. A reader searches the file when the wrap-up note
 * is thin, so a long message or tool result is cut and thinking and images are left out.
 */

import { workPrefix } from "@voluma/contracts/r2";
import { foldHistory } from "../adapters/pi/compaction";
import type { Files } from "../ports/files";
import type { History } from "../ports/history";

const RESULT_CHARS = 2_000;
const MESSAGE_CHARS = 3_000;
const CALL_CHARS = 1_000;

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
            ? [b.text ?? ""]
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
  return `# Transcript\n\n${parts.join("\n\n")}\n`;
}

export async function writeTranscript(o: {
  history: History;
  files: Files;
  runId: string;
  agent: { id: string; name: string };
  signal: AbortSignal;
}): Promise<void> {
  const rows = await o.history.load(o.agent.id);
  await o.files.write(
    `${workPrefix(o.runId)}${o.agent.name}/transcript.md`,
    Buffer.from(renderTranscript(rows)),
    o.signal,
  );
}
