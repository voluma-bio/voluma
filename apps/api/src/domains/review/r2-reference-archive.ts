/** Read-only R2 access to the published scan ZIP. Never buffers the archive in the API. */
import { GetObjectCommand, HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { referenceScanArchiveKey } from "@voluma/contracts/r2";
import { HTTPException } from "hono/http-exception";
import type { ReferenceArchive } from "../../ports";

export function r2ReferenceArchive(config: {
  accountId: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}): ReferenceArchive {
  const client = new S3Client({
    region: "auto",
    endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
  });
  const object = { Bucket: config.bucket, Key: referenceScanArchiveKey() };
  return {
    async head(signal) {
      try {
        const result = await client.send(new HeadObjectCommand(object), { abortSignal: signal });
        const byteLength = archiveLength(result);
        if (!result.ETag) throw new Error("Missing archive version.");
        return { byteLength, version: result.ETag };
      } catch (error) {
        throw storageError(error);
      }
    },
    async open(version, signal) {
      try {
        const result = await client.send(new GetObjectCommand({ ...object, IfMatch: version }), {
          abortSignal: signal,
        });
        if (!result.Body) throw new Error("Missing archive body.");
        const body = result.Body.transformToWebStream();
        try {
          return { body, byteLength: archiveLength(result) };
        } catch (error) {
          await body.cancel().catch(() => {});
          throw error;
        }
      } catch (error) {
        throw storageError(error);
      }
    },
  };
}

function archiveLength(result: { ContentLength?: number; ContentEncoding?: string }): number {
  if (
    result.ContentLength === undefined ||
    !Number.isSafeInteger(result.ContentLength) ||
    result.ContentLength <= 0 ||
    (result.ContentEncoding && result.ContentEncoding.toLowerCase() !== "identity")
  )
    throw new Error("The reference archive must have a positive length and no content encoding.");
  return result.ContentLength;
}

function storageError(error: unknown): HTTPException {
  const missing = error instanceof Error && ["NoSuchKey", "NotFound"].includes(error.name);
  return new HTTPException(missing ? 404 : 502, {
    message: missing ? "Reference scan archive not found." : "Could not read the reference scan.",
  });
}
