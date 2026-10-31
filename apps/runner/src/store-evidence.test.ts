/** Evidence read limits apply to bytes read, not only to an earlier HEAD. */
import { mkdir, mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { evidencePrefix, outputKey } from "@voluma/contracts/r2";
import { EvidenceRefused, MAX_UNMOUNTED_BYTES } from "@voluma/harness/ports/evidence";
import { directoryStore } from "@voluma/object-store/directory";
import { expect, test } from "vitest";
import { storeEvidence } from "./store-evidence.ts";

test.each(["before GET", "during GET"])(
  "unmounted evidence that grows %s is refused",
  async (when) => {
    const root = await mkdtemp(join(tmpdir(), "voluma-evidence-"));
    const key = outputKey("probe", "intake", "growing.bin");
    const path = join(root, key);
    const actual = directoryStore(root, "/unused");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "x");
    try {
      const store = {
        ...actual,
        async head(named: string) {
          const info = await actual.head(named);
          if (named === key && when === "before GET") await truncate(path, MAX_UNMOUNTED_BYTES + 1);
          // An object store is allowed to return no ETag. The byte limit still holds.
          return info && { ...info, etag: undefined };
        },
        async get(named: string) {
          const object = await actual.get(named);
          if (when === "during GET") await truncate(path, MAX_UNMOUNTED_BYTES + 1);
          return object;
        },
      };
      await expect(
        storeEvidence(store).keep("probe", "intake", { root: "outputs", path: "growing.bin" }),
      ).rejects.toBeInstanceOf(EvidenceRefused);
      expect((await actual.list(evidencePrefix("probe"))).objects).toHaveLength(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
