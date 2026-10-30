/**
 * Keeps request size independent of thread length. History keeps every image a tool returned
 * (a resumed thread needs them), but Pi resends all of it with each request, and providers cap
 * a request (Claude: 32 MB, and fewer, smaller images beyond 20). So a request carries image
 * blocks only for the last `KEEP` tool results that have any; older ones are replaced by a
 * note after their text, which already names each file and its sha256. Two calls let the model
 * compare a render with the one before it; at 4 images of 1 MiB each that is under 11 MB.
 * Changing an old message moves the provider's prompt-cache prefix, once per new image call.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";

export const KEEP = 2;
export const ELIDED_NOTE = "[the images are no longer shown; call view_image again to see them]";

/** A message's content with its blocks of image type `type` replaced by one note after the text. */
export function withoutImages<B extends { type: string }>(content: B[], type: string) {
  return [...content.filter((c) => c.type !== type), { type: "text" as const, text: ELIDED_NOTE }];
}

export function elideOldImages(messages: AgentMessage[]): AgentMessage[] {
  let seen = 0;
  const out = [...messages];
  for (let i = out.length - 1; i >= 0; i--) {
    const message = out[i];
    if (message?.role !== "toolResult" || !message.content.some((c) => c.type === "image"))
      continue;
    if (++seen <= KEEP) continue;
    out[i] = { ...message, content: withoutImages(message.content, "image") };
  }
  return out;
}
