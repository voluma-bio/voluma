/**
 * The object store the API, the runner and the operator scripts share: the methods their
 * callers need, over keys built by `@voluma/contracts/r2`. `./r2` is the bucket and
 * `./directory` a local folder with the same keys, for development without R2.
 */

export type ObjectInfo = {
  size: number;
  /** Changes when the bytes do; opaque, as the store reports it. */
  etag: string | undefined;
};

export type ObjectStore = {
  /** The object's size and ETag, or null when there is none. */
  head(key: string, signal?: AbortSignal): Promise<ObjectInfo | null>;
  /**
   * Streams an object. Throws `ObjectNotFound` when there is none. An object with no usable
   * length or a stored Content-Encoding is refused: the SDK doesn't decode it, so its bytes
   * would be served corrupt. `ifMatch` fails the read when the ETag has changed.
   */
  get(
    key: string,
    options?: { ifMatch?: string; signal?: AbortSignal },
  ): Promise<ObjectInfo & { body: ReadableStream<Uint8Array> }>;
  /**
   * Stores the bytes. With `ifNoneMatch` an existing key is kept and the result is false
   * (content-addressed keys never change); otherwise it is replaced and the result is true.
   */
  put(
    key: string,
    bytes: Uint8Array,
    options?: { contentType?: string; ifNoneMatch?: boolean; signal?: AbortSignal },
  ): Promise<boolean>;
  /**
   * A URL for a GET until `expiresIn` seconds after `signingDate` (default now). The same key
   * signed at the same date gets the same URL, so a browser can cache it.
   */
  presignGet(
    key: string,
    options: { expiresIn: number; signingDate?: Date; cacheControl?: string },
  ): Promise<string>;
  /** A URL that accepts one PUT of exactly `size` bytes until `expiresIn` seconds pass. */
  presignPut(key: string, options: { size: number; expiresIn: number }): Promise<string>;
  /**
   * Every object under `prefix`, in key order. With `folder`, only the level below it: the
   * next `/` ends a name, and the folders come back as `folders` (full prefixes). With `limit`,
   * at most that many entries.
   */
  list(
    prefix: string,
    options?: { folder?: boolean; limit?: number; signal?: AbortSignal },
  ): Promise<{ objects: (ObjectInfo & { key: string })[]; folders: string[] }>;
  /** Copies inside the store without moving the bytes through the caller. `ifMatch` is the source's ETag. */
  copy(
    from: string,
    to: string,
    options?: { ifMatch?: string; signal?: AbortSignal },
  ): Promise<void>;
  delete(keys: string[]): Promise<void>;
};

export class ObjectNotFound extends Error {
  constructor(readonly key: string) {
    super(`${key} not found`);
    this.name = "ObjectNotFound";
  }
}

export async function deletePrefix(store: ObjectStore, prefix: string): Promise<void> {
  const { objects } = await store.list(prefix);
  await store.delete(objects.map((o) => o.key));
}

/** Reads a whole object as text. */
export async function getText(store: ObjectStore, key: string): Promise<string> {
  return new Response((await store.get(key)).body).text();
}
