/**
 * The Publish adapter over an object store: hashes the file the agent named (in its sandbox via
 * `hash`; otherwise by reading it here, up to `MAX_UNMOUNTED_BYTES`), then copies it server-side
 * to the version's key with `ifMatch` on the ETag it was hashed at, so a file rewritten since
 * fails the copy instead of publishing other bytes under this hash.
 */
import { createHash } from "node:crypto";
import {
  EvidenceNotFound,
  EvidenceRefused,
  MAX_UNMOUNTED_BYTES,
} from "@voluma/harness/ports/evidence";
import type { Publish } from "@voluma/harness/ports/publish";
import type { ObjectStore } from "@voluma/object-store";

export function storePublish(store: ObjectStore): Publish {
  return {
    async copy(from, to, { hash, signal } = {}) {
      const head = await store.head(from, { signal });
      if (!head) throw new EvidenceNotFound(from);
      if (!hash && head.size > MAX_UNMOUNTED_BYTES)
        throw new EvidenceRefused(
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
  };
}
