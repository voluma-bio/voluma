/** How the API answers when storage can't give an object: 404 for none, 502 when storage fails. */
import { ObjectNotFound, type ObjectStore } from "@voluma/object-store";
import { HTTPException } from "hono/http-exception";

export async function openObject(
  store: ObjectStore,
  key: string,
  signal: AbortSignal,
  messages: { missing: string; failed: string },
  options: { ifMatch?: string; validate?: (size: number) => void } = {},
): Promise<{ body: ReadableStream<Uint8Array>; byteLength: number }> {
  try {
    const { body, size } = await store.get(key, { ifMatch: options.ifMatch, signal });
    try {
      options.validate?.(size);
    } catch (error) {
      await body.cancel().catch(() => {});
      throw error;
    }
    return { body, byteLength: size };
  } catch (error) {
    const missing = error instanceof ObjectNotFound;
    throw new HTTPException(missing ? 404 : 502, {
      message: missing ? messages.missing : messages.failed,
    });
  }
}
