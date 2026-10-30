/**
 * The R2 Evidence adapter, matching `localEvidence`: `keep` takes the sha256 of the file the
 * agent named (under the run's outputs or scratch, in the bucket the sandbox mounts write to)
 * from the sandbox that has it mounted (`hash`), copies it server-side to
 * `evidenceKey(runId, sha256)` unless that is already there, and returns the hash. Only a file
 * its caller's sandbox does not mount is read through the runner, and one over
 * `MAX_UNMOUNTED_BYTES` is refused. A HEAD of the file gives its
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
import {
  type Evidence,
  EvidenceRefused,
  MAX_UNMOUNTED_BYTES,
} from "@voluma/harness/ports/evidence";

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
  async function hashObject(key: string, signal?: AbortSignal): Promise<string> {
    const { Body } = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }), {
      abortSignal: signal,
    });
    if (!Body) throw new Error(`${key} has no body`);
    const hash = createHash("sha256");
    for await (const chunk of Body as AsyncIterable<Uint8Array>) hash.update(chunk);
    return hash.digest("hex");
  }
  return {
    async keep(runId, taskId, file, options) {
      const { hash, signal } = options ?? {};
      const key =
        file.root === "outputs"
          ? outputKey(runId, taskId, file.path)
          : scratchKey(runId, file.path);
      const head = await s3
        .send(new HeadObjectCommand({ Bucket: bucket, Key: key }), { abortSignal: signal })
        .catch((error) => {
          if (error instanceof NotFound) {
            throw new EvidenceRefused(`Evidence ${file.path} does not exist`);
          }
          throw error;
        });
      const etag = head.ETag;
      const seen = hashed.get(key);
      let sha256 = etag && seen?.etag === etag ? seen.sha256 : undefined;
      if (!sha256) {
        if (!hash && (head.ContentLength ?? 0) > MAX_UNMOUNTED_BYTES) {
          throw new EvidenceRefused(
            `Evidence ${file.path} is ${Math.round((head.ContentLength ?? 0) / 2 ** 20)} MiB and your sandbox does not mount it, so it cannot be read here (limit ${MAX_UNMOUNTED_BYTES / 2 ** 20} MiB). Keep it as an output of the task that wrote it, or cite a smaller file.`,
          );
        }
        sha256 = hash ? await hash() : await hashObject(key, signal);
        if (etag) hashed.set(key, { etag, sha256 });
      }
      const target = evidenceKey(runId, sha256);
      // Content-addressed and never overwritten.
      const exists = await s3
        .send(new HeadObjectCommand({ Bucket: bucket, Key: target }), { abortSignal: signal })
        .then(() => true)
        .catch((error) => {
          if (error instanceof NotFound) return false;
          throw error;
        });
      if (!exists) {
        // If-Match: a file rewritten since it was hashed fails the copy instead of storing
        // other bytes under this hash.
        await s3.send(
          new CopyObjectCommand({
            Bucket: bucket,
            Key: target,
            CopySource: `${bucket}/${encodeURIComponent(key).replaceAll("%2F", "/")}`,
            ...(etag && { CopySourceIfMatch: etag }),
          }),
          { abortSignal: signal },
        );
      }
      return sha256;
    },
  };
}
