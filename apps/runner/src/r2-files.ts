/** The R2 Files adapter: reads and writes objects of the run's bucket by key. */
import {
  GetObjectCommand,
  ListObjectsV2Command,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { FileNotFound, type Files } from "@voluma/harness/ports/files";

export function r2Files(config: {
  accountId: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}): Files {
  const s3 = new S3Client({
    region: "auto",
    endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
  });
  return {
    async *read(key, signal) {
      const { Body } = await s3
        .send(new GetObjectCommand({ Bucket: config.bucket, Key: key }), { abortSignal: signal })
        .catch((error) => {
          throw error instanceof NoSuchKey ? new FileNotFound(key) : error;
        });
      if (!Body) throw new Error(`${key} has no body`);
      yield* Body as AsyncIterable<Uint8Array>;
    },
    async write(key, bytes, signal) {
      await s3.send(new PutObjectCommand({ Bucket: config.bucket, Key: key, Body: bytes }), {
        abortSignal: signal,
      });
    },
    async list(prefix, limit, signal) {
      const { Contents = [], CommonPrefixes = [] } = await s3.send(
        new ListObjectsV2Command({
          Bucket: config.bucket,
          Prefix: prefix,
          Delimiter: "/",
          MaxKeys: limit,
        }),
        { abortSignal: signal },
      );
      return [...CommonPrefixes.map((p) => p.Prefix), ...Contents.map((c) => c.Key)]
        .flatMap((k) => (k ? [k.slice(prefix.length)] : []))
        .slice(0, limit);
    },
  };
}
