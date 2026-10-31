/**
 * The Evidence adapter over an object store: `keep` takes the sha256 of the file the
 * agent named (under the run's outputs or scratch, in the bucket the sandbox mounts write to)
 * from the sandbox that has it mounted (`hash`), copies it server-side to
 * `evidenceKey(runId, sha256)` unless that is already there, and returns the hash. Only a file
 * its caller's sandbox does not mount is read through the runner, and one over
 * `MAX_UNMOUNTED_BYTES` is refused. A HEAD of the file gives its
 * ETag; a file reported again with the same ETag (a redo, a second report) keeps its hash, for
 * the life of this adapter (one claim).
 */
import { createHash } from "node:crypto";
import { evidenceKey, outputKey, scratchKey } from "@voluma/contracts/r2";
import {
  type Evidence,
  EvidenceNotFound,
  EvidenceRefused,
  MAX_UNMOUNTED_BYTES,
} from "@voluma/harness/ports/evidence";
import type { ObjectStore } from "@voluma/object-store";

export function storeEvidence(store: ObjectStore): Evidence {
  /** Source key to the ETag and sha256 last seen for it. */
  const hashed = new Map<string, { etag: string; sha256: string }>();
  async function hashObject(
    key: string,
    etag: string | undefined,
    signal?: AbortSignal,
  ): Promise<string> {
    const { body, size } = await store.get(key, { ifMatch: etag, signal });
    const tooLarge = () =>
      new EvidenceRefused(
        `Evidence ${key} exceeds the ${MAX_UNMOUNTED_BYTES / 2 ** 20} MiB host read limit. Keep it as an output of the task that wrote it, or cite a smaller file.`,
      );
    if (size > MAX_UNMOUNTED_BYTES) {
      await body.cancel();
      throw tooLarge();
    }
    const hash = createHash("sha256");
    let read = 0;
    for await (const chunk of body) {
      read += chunk.length;
      if (read > MAX_UNMOUNTED_BYTES) throw tooLarge();
      hash.update(chunk);
    }
    return hash.digest("hex");
  }
  return {
    async keep(runId, taskId, file, options) {
      const { hash, signal } = options ?? {};
      const key =
        file.root === "outputs"
          ? outputKey(runId, taskId, file.path)
          : scratchKey(runId, file.path);
      const head = await store.head(key, { signal });
      if (!head) throw new EvidenceNotFound(key);
      const etag = head.etag;
      const seen = hashed.get(key);
      let sha256 = etag && seen?.etag === etag ? seen.sha256 : undefined;
      if (!sha256) {
        if (!hash && head.size > MAX_UNMOUNTED_BYTES) {
          throw new EvidenceRefused(
            `Evidence ${file.path} is ${Math.round(head.size / 2 ** 20)} MiB and your sandbox does not mount it, so it cannot be read here (limit ${MAX_UNMOUNTED_BYTES / 2 ** 20} MiB). Keep it as an output of the task that wrote it, or cite a smaller file.`,
          );
        }
        sha256 = hash ? await hash() : await hashObject(key, etag, signal);
        if (etag) hashed.set(key, { etag, sha256 });
      }
      const target = evidenceKey(runId, sha256);
      // Content-addressed and never overwritten.
      if (!(await store.head(target, { signal }))) {
        // ifMatch: a file rewritten since it was hashed fails the copy instead of storing
        // other bytes under this hash.
        await store.copy(key, target, { ifMatch: etag, signal });
      }
      return sha256;
    },
  };
}
