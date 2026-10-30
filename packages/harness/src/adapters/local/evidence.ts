/**
 * The local Evidence adapter: a directory stands in for the run's bucket, with the same
 * keys (`@voluma/contracts/r2`). `keep` hashes the file the agent named under `dir`, copies
 * it to `evidenceKey(runId, sha256)` unless that is already there, and returns the hash.
 * For runs whose sandbox writes to a local directory; the R2 adapter comes with the
 * deployed runner.
 */
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { evidenceKey, outputKey, scratchKey } from "@voluma/contracts/r2";
import { type Evidence, EvidenceNotFound } from "../../ports/evidence";

export function localEvidence(dir: string): Evidence {
  return {
    async keep(runId, taskId, file) {
      const key =
        file.root === "outputs"
          ? outputKey(runId, taskId, file.path)
          : scratchKey(runId, file.path);
      const source = join(dir, key);
      const bytes = await readFile(source).catch((error) => {
        throw error?.code === "ENOENT" ? new EvidenceNotFound(key) : error;
      });
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const target = join(dir, evidenceKey(runId, sha256));
      await mkdir(dirname(target), { recursive: true });
      // COPYFILE_EXCL: content-addressed and never overwritten.
      await copyFile(source, target, 1).catch((error) => {
        if (error?.code !== "EEXIST") throw error;
      });
      return sha256;
    },
  };
}
