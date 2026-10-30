/**
 * The R2 Outputs adapter: `/outputs` is the prefix `outputsPrefix(runId)`, its backup
 * `outputsBackupPrefix(runId, reopenId)`. Both copies are server-side `CopyObject` (a run's
 * outputs run to hundreds of MB), listed page by page. `holds` compares a file with its
 * content-addressed evidence copy by size and ETag, so no bytes are read. R2 gives a copy of a
 * multipart-uploaded object the plain content ETag, so the comparison is only meaningful on a
 * file that is itself a copy, as one `restore` has just written.
 */
import {
  CopyObjectCommand,
  DeleteObjectsCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  NotFound,
  S3Client,
} from "@aws-sdk/client-s3";
import { evidenceKey, outputKey, outputsBackupPrefix, outputsPrefix } from "@voluma/contracts/r2";
import type { Outputs } from "@voluma/harness/ports/outputs";

/** How many copies run at once. */
const COPY_CONCURRENCY = 16;

export function r2Outputs(config: {
  accountId: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}): Outputs {
  const { bucket } = config;
  const s3 = new S3Client({
    region: "auto",
    endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
  });

  async function* keysUnder(prefix: string, signal: AbortSignal) {
    let token: string | undefined;
    do {
      const page = await s3.send(
        new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }),
        { abortSignal: signal },
      );
      for (const o of page.Contents ?? []) if (o.Key) yield o.Key;
      token = page.NextContinuationToken;
    } while (token);
  }

  async function clear(prefix: string, signal: AbortSignal) {
    let batch: string[] = [];
    const flush = async () => {
      if (batch.length === 0) return;
      const { Errors } = await s3.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
        }),
        { abortSignal: signal },
      );
      if (Errors?.length) throw new Error(`deleting under ${prefix} failed: ${Errors[0]?.Message}`);
      batch = [];
    };
    for await (const key of keysUnder(prefix, signal)) {
      batch.push(key);
      if (batch.length === 1000) await flush();
    }
    await flush();
  }

  /** Replaces everything under `to` with a copy of everything under `from`. */
  async function mirror(from: string, to: string, signal: AbortSignal) {
    await clear(to, signal);
    const pending = new Set<Promise<void>>();
    for await (const key of keysUnder(from, signal)) {
      const copy: Promise<void> = s3
        .send(
          new CopyObjectCommand({
            Bucket: bucket,
            Key: `${to}${key.slice(from.length)}`,
            CopySource: `${bucket}/${encodeURIComponent(key).replaceAll("%2F", "/")}`,
          }),
          { abortSignal: signal },
        )
        .then(() => {
          pending.delete(copy);
        });
      pending.add(copy);
      if (pending.size >= COPY_CONCURRENCY) await Promise.race(pending);
    }
    await Promise.all(pending);
  }

  const head = (Key: string, signal: AbortSignal) =>
    s3
      .send(new HeadObjectCommand({ Bucket: bucket, Key }), { abortSignal: signal })
      .catch((error) => {
        if (error instanceof NotFound) return undefined;
        throw error;
      });

  return {
    backup: (runId, reopenId, signal) =>
      mirror(outputsPrefix(runId), outputsBackupPrefix(runId, reopenId), signal),
    restore: (runId, reopenId, signal) =>
      mirror(outputsBackupPrefix(runId, reopenId), outputsPrefix(runId), signal),
    async holds(runId, taskId, path, sha256, signal) {
      const [file, evidence] = await Promise.all([
        head(outputKey(runId, taskId, path), signal),
        head(evidenceKey(runId, sha256), signal),
      ]);
      return (
        !!file &&
        !!evidence &&
        file.ContentLength === evidence.ContentLength &&
        file.ETag === evidence.ETag
      );
    },
  };
}
