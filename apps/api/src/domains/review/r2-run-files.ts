/** Run files and message snapshots in R2, plus presigned converted assets. Content-addressed writes never replace bytes. */
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { evidenceKey, messageSnapshotKey, reviewAssetKey } from "@voluma/contracts/r2";
import { HTTPException } from "hono/http-exception";
import type { RunFiles } from "../../ports";

/** A URL is signed at the start of a window and valid for `ASSET_URL_SECONDS` from there, so a request gets one with at least the difference left. */
const ASSET_WINDOW_SECONDS = 240;
const ASSET_URL_SECONDS = 300;

export function r2RunFiles(config: {
  accountId: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}): RunFiles {
  const client = new S3Client({
    region: "auto",
    endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    // No default checksum on the snapshot PUT: R2 takes the plain body.
    requestChecksumCalculation: "WHEN_REQUIRED",
  });
  async function read(key: string, signal: AbortSignal) {
    try {
      const result = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }), {
        abortSignal: signal,
      });
      if (!result.Body) throw new Error("Missing file body.");
      const body = result.Body.transformToWebStream();
      // The SDK doesn't decode a stored Content-Encoding; serving those bytes would corrupt the file.
      const encoding = result.ContentEncoding?.toLowerCase();
      if (
        result.ContentLength === undefined ||
        !Number.isSafeInteger(result.ContentLength) ||
        (encoding && encoding !== "identity")
      ) {
        await body.cancel().catch(() => {});
        throw new Error("A run file must have a length and no content encoding.");
      }
      return { body, byteLength: result.ContentLength };
    } catch (error) {
      const missing = error instanceof Error && ["NoSuchKey", "NotFound"].includes(error.name);
      throw new HTTPException(missing ? 404 : 502, {
        message: missing ? "File not found." : "Could not read the file.",
      });
    }
  }

  return {
    async put(runId, sha256, bytes, signal) {
      try {
        await client.send(
          new PutObjectCommand({
            Bucket: config.bucket,
            Key: evidenceKey(runId, sha256),
            Body: bytes,
            ContentType: "image/png",
            IfNoneMatch: "*",
          }),
          { abortSignal: signal },
        );
      } catch (error) {
        // The same content may already be evidence, or another save may have just written it.
        if (error instanceof S3ServiceException && error.$metadata.httpStatusCode === 412) return;
        throw new HTTPException(502, { message: "Could not save the screenshot." });
      }
    },
    async putSnapshot(runId, messageId, png) {
      await client.send(
        new PutObjectCommand({
          Bucket: config.bucket,
          Key: messageSnapshotKey(runId, messageId),
          Body: png,
          ContentType: "image/png",
        }),
      );
    },
    async assetUrl(runId, sha256, path) {
      const now = Date.now();
      const windowMs = ASSET_WINDOW_SECONDS * 1000;
      const signingDate = new Date(Math.floor(now / windowMs) * windowMs);
      const url = await getSignedUrl(
        client,
        new GetObjectCommand({
          Bucket: config.bucket,
          Key: reviewAssetKey(runId, sha256, path),
          // Content-addressed: the bytes never change. A day, like the files route.
          ResponseCacheControl: "private, max-age=86400, immutable",
        }),
        { expiresIn: ASSET_URL_SECONDS, signingDate },
      );
      return {
        url,
        validSeconds: Math.floor((signingDate.getTime() + ASSET_URL_SECONDS * 1000 - now) / 1000),
      };
    },
    open: (runId, sha256, signal) => read(evidenceKey(runId, sha256), signal),
    openSnapshot: (runId, messageId, signal) => read(messageSnapshotKey(runId, messageId), signal),
  };
}
