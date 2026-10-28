/**
 * The R2 Evidence adapter, matching `localEvidence`: `keep` hashes the file the agent named
 * (under the run's outputs or scratch, in the bucket the sandbox mounts write to), copies it
 * to `evidenceKey(runId, sha256)` unless that is already there, and returns the hash.
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
  return {
    async keep(runId, taskId, file) {
      const key =
        file.root === "outputs"
          ? outputKey(runId, taskId, file.path)
          : scratchKey(runId, file.path);
      // Rejects with NoSuchKey when the file does not exist: nothing is stored then.
      const { Body } = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      if (!Body) throw new Error(`${key} has no body`);
      const hash = createHash("sha256");
      for await (const chunk of Body as AsyncIterable<Uint8Array>) hash.update(chunk);
      const sha256 = hash.digest("hex");
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
