/**
 * The RunBucket adapter over an object store: reads and writes objects of the run's bucket by
 * key. `copy` hashes the file the agent named (in its sandbox via `hash`; otherwise by reading it
 * here, up to `MAX_UNMOUNTED_BYTES`), then copies it server-side to the version's key with
 * `ifMatch` on the ETag it was hashed at, so a file rewritten since fails the copy instead of
 * publishing other bytes under this hash.
 */
import { createHash } from "node:crypto";
import {
  FileNotFound,
  FileRefused,
  MAX_UNMOUNTED_BYTES,
  type RunBucket,
} from "@voluma/harness/ports/bucket";
import { ObjectNotFound, type ObjectStore } from "@voluma/object-store";

const MAX_SMALL_BYTES = 1024 * 1024;

export function storeBucket(store: ObjectStore): RunBucket {
  return {
    async *read(key, signal) {
      const { body } = await store.get(key, { signal }).catch((error) => {
        throw error instanceof ObjectNotFound ? new FileNotFound(key) : error;
      });
      yield* body;
    },
    async write(key, bytes, signal) {
      await store.put(key, bytes, { signal });
    },
    async list(prefix, limit, signal) {
      const { objects, folders } = await store.list(prefix, { folder: true, limit, signal });
      return [...folders, ...objects.map((o) => o.key)]
        .map((k) => k.slice(prefix.length))
        .slice(0, limit);
    },
    async copy(from, to, { hash, signal } = {}) {
      const head = await store.head(from, { signal });
      if (!head) throw new FileNotFound(from);
      if (!hash && head.size > MAX_UNMOUNTED_BYTES)
        throw new FileRefused(
          `${from} is ${Math.round(head.size / 2 ** 20)} MiB, over the ${MAX_UNMOUNTED_BYTES / 2 ** 20} MiB the host reads.`,
        );
      let sha256: string;
      if (hash) sha256 = await hash();
      else {
        const digest = createHash("sha256");
        const { body } = await store.get(from, { ifMatch: head.etag, signal });
        for await (const chunk of body) digest.update(chunk);
        sha256 = digest.digest("hex");
      }
      await store.copy(from, to, { ifMatch: head.etag, signal });
      return sha256;
    },
    async readText(key, { signal } = {}) {
      const head = await store.head(key, { signal });
      if (!head) return undefined;
      if (head.size > MAX_SMALL_BYTES) throw new FileRefused(`${key} is not a small file.`);
      return new Response((await store.get(key, { ifMatch: head.etag, signal })).body).text();
    },
    async writeText(key, text, { signal } = {}) {
      await store.put(key, new TextEncoder().encode(text), { contentType: "text/plain", signal });
    },
    remove: (key) => store.delete([key]),
  };
}
