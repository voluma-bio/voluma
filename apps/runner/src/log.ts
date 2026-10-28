/** One console line for a stored event, clipped. */
import type { EventInput } from "@voluma/contracts/events";

const clip = (value: unknown, max = 300) => {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max)}…` : text;
};

export function eventLine(event: EventInput): string {
  const p = event.payload as Record<string, unknown>;
  const thread = event.threadId.slice(event.runId.length + 1);
  switch (event.type) {
    case "message":
      return `${thread} [${p.role}] ${clip(p.text)}`;
    case "tool.call":
      return `${thread} [call] ${clip(p.input)}`;
    case "tool.result":
      return `${thread} [result${p.isError ? " error" : ""}] ${clip(p.output)}`;
    default:
      return `${thread} [${event.type}] ${clip(p)}`;
  }
}
