/** Review's keys in the object store: a run's files, message snapshots and converted assets. */
import { evidenceKey, reviewAssetKey } from "@voluma/contracts/r2";
import { ObjectNotFound, type ObjectStore } from "@voluma/object-store";
import { HTTPException } from "hono/http-exception";

/** A URL is signed at the start of a window and valid for `ASSET_URL_SECONDS` from there, so a request gets one with at least the difference left. */
const ASSET_WINDOW_SECONDS = 240;
const ASSET_URL_SECONDS = 300;

/** Opens an object for streaming: 404 when storage has none, 502 when storage fails. */
export async function openObject(
  store: ObjectStore,
  key: string,
  signal: AbortSignal,
  messages: { missing: string; failed: string },
  ifMatch?: string,
): Promise<{ body: ReadableStream<Uint8Array>; byteLength: number }> {
  try {
    const { body, size } = await store.get(key, { ifMatch, signal });
    return { body, byteLength: size };
  } catch (error) {
    const missing = error instanceof ObjectNotFound;
    throw new HTTPException(missing ? 404 : 502, {
      message: missing ? messages.missing : messages.failed,
    });
  }
}

export const openFile = (store: ObjectStore, key: string, signal: AbortSignal) =>
  openObject(store, key, signal, {
    missing: "File not found.",
    failed: "Could not read the file.",
  });

/**
 * A short-lived URL for one converted asset of the run, with the seconds it stays valid for.
 * The same file asked for again soon gets the same URL (signed at a window's start), so the
 * browser's cache can serve the repeat. Does not check that the object exists.
 */
export async function assetUrl(store: ObjectStore, runId: string, sha256: string, path: string) {
  const now = Date.now();
  const windowMs = ASSET_WINDOW_SECONDS * 1000;
  const signingDate = new Date(Math.floor(now / windowMs) * windowMs);
  const url = await store.presignGet(reviewAssetKey(runId, sha256, path), {
    expiresIn: ASSET_URL_SECONDS,
    signingDate,
    // Content-addressed: the bytes never change. A day, like the files route.
    cacheControl: "private, max-age=86400, immutable",
  });
  return {
    url,
    validSeconds: Math.floor((signingDate.getTime() + ASSET_URL_SECONDS * 1000 - now) / 1000),
  };
}
