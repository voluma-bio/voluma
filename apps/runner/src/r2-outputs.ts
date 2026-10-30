/**
 * The R2 Outputs adapter: `/outputs` is the prefix `outputsPrefix(runId)`, its backup
 * `outputsBackupPrefix(runId, reopenId)`. Both copies are server-side `CopyObject` (a run's
 * outputs run to hundreds of MB), listed page by page. `restore` ends by comparing the two
 * listings (key and ETag per key, no bytes read); both sides are `CopyObject` copies, so their
 * ETags agree.
 */
import {
  CopyObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";
import { outputsBackupPrefix, outputsPrefix } from "@voluma/contracts/r2";
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

  async function* entriesUnder(prefix: string, signal: AbortSignal) {
    let token: string | undefined;
    do {
      const page = await s3.send(
        new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }),
        { abortSignal: signal },
      );
      for (const o of page.Contents ?? []) if (o.Key) yield { key: o.Key, etag: o.ETag };
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
    for await (const { key } of entriesUnder(prefix, signal)) {
      batch.push(key);
      if (batch.length === 1000) await flush();
    }
    await flush();
  }

  /** Replaces everything under `to` with a copy of everything under `from`. */
  async function mirror(from: string, to: string, signal: AbortSignal) {
    await clear(to, signal);
    const pending = new Set<Promise<void>>();
    for await (const { key } of entriesUnder(from, signal)) {
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

  /** Throws unless `to` holds exactly the keys of `from`, with the same ETags. */
  async function expectSame(from: string, to: string, signal: AbortSignal) {
    const listed = async (prefix: string) => {
      const found = new Map<string, string | undefined>();
      for await (const e of entriesUnder(prefix, signal))
        found.set(e.key.slice(prefix.length), e.etag);
      return found;
    };
    const [want, got] = await Promise.all([listed(from), listed(to)]);
    const wrong = [...new Set([...want.keys(), ...got.keys()])].filter(
      (k) => !want.has(k) || !got.has(k) || want.get(k) !== got.get(k),
    );
    if (wrong.length > 0)
      throw new Error(
        `the restored outputs differ from the backup: ${wrong.slice(0, 5).join(", ")}`,
      );
  }

  return {
    backup: (runId, reopenId, signal) =>
      mirror(outputsPrefix(runId), outputsBackupPrefix(runId, reopenId), signal),
    async restore(runId, reopenId, signal) {
      const backup = outputsBackupPrefix(runId, reopenId);
      await mirror(backup, outputsPrefix(runId), signal);
      await expectSame(backup, outputsPrefix(runId), signal);
    },
    // Best effort: a cancelled claim still mirroring can write after this clear and orphan a copy.
    discard: (runId, reopenId, signal) => clear(outputsBackupPrefix(runId, reopenId), signal),
  };
}
