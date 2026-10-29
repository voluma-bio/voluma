/**
 * The R2 Evidence adapter, matching `localEvidence`: `keep` takes the sha256 of the file the
 * agent named (under the run's outputs or scratch, in the bucket the sandbox mounts write to)
 * from the sandbox that has it mounted (`hash`), copies it server-side to
 * `evidenceKey(runId, sha256)` unless that is already there, and returns the hash. Only a file
 * its caller's sandbox does not mount is read through the runner. A HEAD of the file gives its
 * ETag; a file reported again with the same ETag (a redo, a second report) keeps its hash, for
 * the life of this adapter (one claim).
 */
import { createHash } from "node:crypto";
import {
  CopyObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  NotFound,
  S3Client,
} from "@aws-sdk/client-s3";
import { evidenceKey, outputKey, scratchKey } from "@voluma/contracts/r2";
import type { Evidence } from "@voluma/harness/ports/evidence";

export function r2Evidence(config: {
  accountId: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}): Evidence {
  const { bucket } = config;
  const s3 = new S3Client({
    region: "auto",
    endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
  });
  /** Source key to the ETag and sha256 last seen for it. */
  const hashed = new Map<string, { etag: string; sha256: string }>();
  async function hashObject(key: string): Promise<string> {
    const { Body } = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    if (!Body) throw new Error(`${key} has no body`);
    const hash = createHash("sha256");
    for await (const chunk of Body as AsyncIterable<Uint8Array>) hash.update(chunk);
    return hash.digest("hex");
  }
  return {
    async keep(runId, taskId, file, hash) {
      const key =
        file.root === "outputs"
          ? outputKey(runId, taskId, file.path)
          : scratchKey(runId, file.path);
      // Rejects with NotFound when the file does not exist: nothing is stored then.
      const { ETag: etag } = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      const seen = hashed.get(key);
      let sha256 = etag && seen?.etag === etag ? seen.sha256 : undefined;
      if (!sha256) {
        sha256 = (await hash?.()) ?? (await hashObject(key));
        if (etag) hashed.set(key, { etag, sha256 });
      }
      const target = evidenceKey(runId, sha256);
      // Content-addressed and never overwritten.
      const exists = await s3
        .send(new HeadObjectCommand({ Bucket: bucket, Key: target }))
        .then(() => true)
        .catch((error) => {
          if (error instanceof NotFound) return false;
          throw error;
        });
      if (!exists) {
        await s3.send(
          new CopyObjectCommand({
            Bucket: bucket,
            Key: target,
            CopySource: `${bucket}/${encodeURIComponent(key).replaceAll("%2F", "/")}`,
          }),
        );
      }
      return sha256;
    },
  };
}
