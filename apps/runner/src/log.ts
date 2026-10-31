/** One console line for a stored event: redacted first, then clipped (a clipped key would escape the mask). */
import type { EventInput } from "@voluma/contracts/events";
import type { Redact } from "./redact.ts";

export function eventLine(
  event: EventInput,
  redact: Redact,
  /** A thread's name for the line; the id where the thread has none. */
  nameOf: (threadId: string) => string,
): string {
  const clip = (value: unknown, max = 300) => {
    const text = redact(typeof value === "string" ? value : JSON.stringify(value));
    return text.length > max ? `${text.slice(0, max)}…` : text;
  };
  const p = event.payload as Record<string, unknown>;
  const thread = nameOf(event.threadId);
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
