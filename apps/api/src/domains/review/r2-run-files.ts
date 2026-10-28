/** Read-only R2 access to a run's content-addressed files (`evidenceKey`). Streams; never buffers. */
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { evidenceKey } from "@voluma/contracts/r2";
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
    async open(runId, sha256, signal) {
      try {
        const result = await client.send(
          new GetObjectCommand({ Bucket: config.bucket, Key: evidenceKey(runId, sha256) }),
          { abortSignal: signal },
        );
        if (!result.Body || result.ContentLength === undefined)
          throw new Error("Missing file body or length.");
        return { body: result.Body.transformToWebStream(), byteLength: result.ContentLength };
      } catch (error) {
        const missing = error instanceof Error && ["NoSuchKey", "NotFound"].includes(error.name);
        throw new HTTPException(missing ? 404 : 502, {
          message: missing ? "File not found." : "Could not read the file.",
        });
      }
    },
  };
}
