/** The R2 bucket as an `ObjectStore`, and the one S3 client every R2 caller builds. */
import {
  CopyObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { ObjectNotFound, type ObjectStore } from "./index";

export type R2Config = {
  accountId: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
};

/** What differs between callers; the default is the SDK's own. */
export type R2Options = {
  /** `when-required`: no default checksum on a PUT. R2 takes the plain body, and a presigned PUT would otherwise sign the checksum of its (empty) presign-time body, which every real PUT fails. */
  checksum?: "when-required";
  /** Retries and timeouts, so a stalled connection can't hang a script for good (the SDK retries after a timeout). */
  retries?: { maxAttempts: number; connectionTimeoutMs: number; requestTimeoutMs: number };
};

export function r2Client(config: R2Config, options: R2Options = {}): S3Client {
  return new S3Client({
    region: "auto",
    endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    ...(options.checksum && { requestChecksumCalculation: "WHEN_REQUIRED" }),
    ...(options.retries && {
      maxAttempts: options.retries.maxAttempts,
      requestHandler: {
        connectionTimeout: options.retries.connectionTimeoutMs,
        requestTimeout: options.retries.requestTimeoutMs,
      },
    }),
  });
}

const statusOf = (error: unknown) =>
  error instanceof S3ServiceException ? error.$metadata.httpStatusCode : undefined;
const isMissing = (error: unknown) =>
  statusOf(error) === 404 ||
  (error instanceof Error && ["NoSuchKey", "NotFound"].includes(error.name));

export function r2Store(config: R2Config, options: R2Options = {}): ObjectStore {
  const client = r2Client(config, options);
  const Bucket = config.bucket;

  return {
    async head(Key, signal) {
      try {
        const head = await client.send(new HeadObjectCommand({ Bucket, Key }), {
          abortSignal: signal,
        });
        return { size: head.ContentLength ?? 0, etag: head.ETag };
      } catch (error) {
        if (isMissing(error)) return null;
        throw error;
      }
    },

    async get(Key, { ifMatch, signal } = {}) {
      const result = await client
        .send(new GetObjectCommand({ Bucket, Key, IfMatch: ifMatch }), { abortSignal: signal })
        .catch((error) => {
          throw isMissing(error) ? new ObjectNotFound(Key) : error;
        });
      if (!result.Body) throw new Error(`${Key} has no body`);
      const body = result.Body.transformToWebStream();
      const encoding = result.ContentEncoding?.toLowerCase();
      if (
        result.ContentLength === undefined ||
        !Number.isSafeInteger(result.ContentLength) ||
        (encoding && encoding !== "identity")
      ) {
        await body.cancel().catch(() => {});
        throw new Error(`${Key} must have a length and no content encoding.`);
      }
      return { body, size: result.ContentLength, etag: result.ETag };
    },

    async put(Key, Body, { contentType, ifNoneMatch, signal } = {}) {
      try {
        await client.send(
          new PutObjectCommand({
            Bucket,
            Key,
            Body,
            ContentType: contentType,
            ...(ifNoneMatch && { IfNoneMatch: "*" }),
          }),
          { abortSignal: signal },
        );
        return true;
      } catch (error) {
        if (ifNoneMatch && statusOf(error) === 412) return false;
        throw error;
      }
    },

    presignGet: (Key, { expiresIn, signingDate, cacheControl }) =>
      getSignedUrl(
        client,
        new GetObjectCommand({ Bucket, Key, ResponseCacheControl: cacheControl }),
        { expiresIn, signingDate },
      ),

    presignPut: (Key, { size, expiresIn }) =>
      getSignedUrl(client, new PutObjectCommand({ Bucket, Key, ContentLength: size }), {
        expiresIn,
        // Signed, so storage refuses a body of any other length.
        signableHeaders: new Set(["content-length"]),
      }),

    async list(Prefix, { folder, limit, signal } = {}) {
      const objects: { key: string; size: number; etag: string | undefined }[] = [];
      const folders: string[] = [];
      for (let ContinuationToken: string | undefined; ; ) {
        const page = await client.send(
          new ListObjectsV2Command({
            Bucket,
            Prefix,
            ContinuationToken,
            ...(folder && { Delimiter: "/" }),
            ...(limit !== undefined && { MaxKeys: limit }),
          }),
          { abortSignal: signal },
        );
        for (const o of page.Contents ?? [])
          if (o.Key) objects.push({ key: o.Key, size: o.Size ?? 0, etag: o.ETag });
        for (const p of page.CommonPrefixes ?? []) if (p.Prefix) folders.push(p.Prefix);
        ContinuationToken = page.NextContinuationToken;
        if (!ContinuationToken || limit !== undefined) return { objects, folders };
      }
    },

    async copy(from, Key, { ifMatch, signal } = {}) {
      await client.send(
        new CopyObjectCommand({
          Bucket,
          Key,
          // The source is a URL path: encode each segment (`#`, `?`, spaces).
          CopySource: `${Bucket}/${from.split("/").map(encodeURIComponent).join("/")}`,
          CopySourceIfMatch: ifMatch,
        }),
        { abortSignal: signal },
      );
    },

    async delete(keys) {
      for (let i = 0; i < keys.length; i += 1000) {
        await client.send(
          new DeleteObjectsCommand({
            Bucket,
            Delete: { Objects: keys.slice(i, i + 1000).map((Key) => ({ Key })), Quiet: true },
          }),
        );
      }
    },
  };
}
