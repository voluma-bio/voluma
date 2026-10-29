/**
 * Read-only R2 access to a run's content-addressed files (`evidenceKey`), streamed and never
 * buffered, and presigned GETs for its converted review assets (`reviewAssetKey`).
 */
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { evidenceKey, reviewAssetKey } from "@voluma/contracts/r2";
import { HTTPException } from "hono/http-exception";
import type { RunFiles } from "../../ports";

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
  });
  return {
    assetUrl: (runId, sha256, path) =>
      getSignedUrl(
        client,
        new GetObjectCommand({
          Bucket: config.bucket,
          Key: reviewAssetKey(runId, sha256, path),
          // The key names the source bytes and the asset's path, so its bytes never change.
          ResponseCacheControl: "private, max-age=86400, immutable",
        }),
        { expiresIn: 600 },
      ),
    async open(runId, sha256, signal) {
      try {
        const result = await client.send(
          new GetObjectCommand({ Bucket: config.bucket, Key: evidenceKey(runId, sha256) }),
          { abortSignal: signal },
        );
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
    },
  };
}
