/** The R2 adapter of `WorkflowStore` (`@voluma/workflow/load`): where imported packages live. */
import {
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  NotFound,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type { WorkflowStore } from "@voluma/workflow/load";

export function r2Workflows(config: {
  accountId: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}): WorkflowStore {
  const Bucket = config.bucket;
  const s3 = new S3Client({
    region: "auto",
    endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
  });
  return {
    async has(Key) {
      try {
        await s3.send(new HeadObjectCommand({ Bucket, Key }));
        return true;
      } catch (error) {
        if (error instanceof NotFound) return false;
        throw error;
      }
    },
    async put(Key, Body) {
      await s3.send(new PutObjectCommand({ Bucket, Key, Body }));
    },
    async list(Prefix) {
      const keys: string[] = [];
      let ContinuationToken: string | undefined;
      do {
        const page = await s3.send(new ListObjectsV2Command({ Bucket, Prefix, ContinuationToken }));
        for (const o of page.Contents ?? []) if (o.Key) keys.push(o.Key);
        ContinuationToken = page.NextContinuationToken;
      } while (ContinuationToken);
      return keys;
    },
    async get(Key) {
      const { Body } = await s3.send(new GetObjectCommand({ Bucket, Key }));
      if (!Body) throw new Error(`${Key} has no body`);
      return Body.transformToString();
    },
  };
}
