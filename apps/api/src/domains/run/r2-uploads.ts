/**
 * The object store side of scan uploads (`@voluma/contracts/run`, Uploads): presigned PUT
 * URLs straight to R2, the sizes of what landed under a prefix, the move from the
 * staging prefix to the input's own, and deleting a cancelled upload's files. The API holds the R2 keys; no file's bytes pass
 * through it (a copy is server-side in R2). Built by index.ts.
 */
import {
  CopyObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export function r2Uploads(config: {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}) {
  const s3 = new S3Client({
    region: "auto",
    endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    // Otherwise the SDK signs a checksum of the (empty) presign-time body into the URL, and
    // every real PUT fails it.
    requestChecksumCalculation: "WHEN_REQUIRED",
  });
  const bucket = config.bucket;

  return {
    /** A URL that accepts one PUT of exactly `size` bytes to `key`, until `expiresIn` seconds pass. */
    presignPut: (key: string, size: number, expiresIn: number) =>
      getSignedUrl(s3, new PutObjectCommand({ Bucket: bucket, Key: key, ContentLength: size }), {
        expiresIn,
        // Signed, so storage refuses a body of any other length.
        signableHeaders: new Set(["content-length"]),
      }),

    /** Every object under `prefix`: key relative to the prefix → bytes. */
    async sizes(prefix: string): Promise<Map<string, number>> {
      const found = new Map<string, number>();
      for (let token: string | undefined; ; ) {
        const page = await s3.send(
          new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }),
        );
        for (const object of page.Contents ?? []) {
          found.set((object.Key as string).slice(prefix.length), object.Size ?? 0);
        }
        token = page.NextContinuationToken;
        if (!token) return found;
      }
    },

    /** Copies each `[from, to]` inside the bucket (R2 copies up to 5 GB), then deletes every `from`. */
    async move(pairs: [from: string, to: string][]): Promise<void> {
      const queue = [...pairs];
      const copyNext = async (): Promise<void> => {
        for (let pair = queue.shift(); pair; pair = queue.shift()) {
          await s3.send(
            new CopyObjectCommand({
              Bucket: bucket,
              // The source is a URL path: encode each segment (`#`, `?`, spaces).
              CopySource: `${bucket}/${pair[0].split("/").map(encodeURIComponent).join("/")}`,
              Key: pair[1],
            }),
          );
        }
      };
      await Promise.all(Array.from({ length: 16 }, copyNext));
      await deleteKeys(pairs.map(([from]) => from));
    },

    /** Deletes every object under `prefix`. */
    async deletePrefix(prefix: string): Promise<void> {
      await deleteKeys([...(await this.sizes(prefix)).keys()].map((k) => prefix + k));
    },
  };

  async function deleteKeys(keys: string[]): Promise<void> {
    for (let i = 0; i < keys.length; i += 1000) {
      await s3.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: keys.slice(i, i + 1000).map((Key) => ({ Key })), Quiet: true },
        }),
      );
    }
  }
}

export type Uploads = ReturnType<typeof r2Uploads>;
