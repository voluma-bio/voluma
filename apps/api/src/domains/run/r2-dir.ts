/**
 * Operator scripts move a folder of files between disk and R2: `export:run`, `import:run`,
 * `seed:example --backfill` and `r2:put` all take either a local folder or `r2:<prefix>`
 * (`r2:dev/runs/<id>/`). An `r2:` folder is downloaded to a temp folder first, so the code after
 * it reads a plain folder. Reads the R2 settings from the environment (the repo .env).
 */
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import {
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { relativePathSchema } from "@voluma/contracts/r2";

export const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
};

export function r2FromEnv(): { r2: S3Client; bucket: string } {
  return {
    bucket: required("R2_BUCKET"),
    r2: new S3Client({
      region: "auto",
      maxAttempts: 8,
      // A stalled connection would otherwise hang a script for good; the SDK retries after a timeout.
      requestHandler: { connectionTimeout: 15_000, requestTimeout: 120_000 },
      endpoint: `https://${required("R2_ACCOUNT_ID")}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: required("R2_ACCESS_KEY_ID"),
        secretAccessKey: required("R2_SECRET_ACCESS_KEY"),
      },
    }),
  };
}

/** `r2:<prefix>` as a prefix ending in `/`, or null for a local folder. */
export function r2Prefix(spec: string): string | null {
  if (!spec.startsWith("r2:")) return null;
  const prefix = spec.slice(3).replace(/\/*$/, "/");
  if (prefix === "/") throw new Error(`${spec} names no folder`);
  return prefix;
}

export async function exists(
  r2: S3Client,
  bucket: string,
  key: string,
  size: number,
): Promise<boolean> {
  try {
    const head = await r2.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return head.ContentLength === size;
  } catch (error) {
    if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) {
      return false;
    }
    throw error;
  }
}

/** Stores the file unless the key already holds an object of the same size. */
export async function put(r2: S3Client, bucket: string, key: string, path: string): Promise<void> {
  const { size } = await stat(path);
  if (await exists(r2, bucket, key, size)) return;
  // A buffer, not a stream: the SDK can retry it when the connection drops.
  await r2.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: await readFile(path) }));
}

/** Runs `work` over `items`, `limit` at a time. */
export async function pool<T>(items: T[], limit: number, work: (item: T) => Promise<void>) {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: limit }, async () => {
      for (let item = queue.shift(); item !== undefined; item = queue.shift()) await work(item);
    }),
  );
}

/** Relative paths of every file under `dir/prefix`. */
export async function filesUnder(dir: string, prefix = ""): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(join(dir, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...(await filesUnder(dir, path)));
    else found.push(path);
  }
  return found;
}

export async function uploadDir(
  r2: S3Client,
  bucket: string,
  dir: string,
  prefix: string,
): Promise<number> {
  const paths = await filesUnder(dir);
  // A reader treats a folder with its manifest as complete, so manifests go last.
  const isManifest = (p: string) => p.endsWith("manifest.json");
  await pool(
    paths.filter((p) => !isManifest(p)),
    16,
    (p) => put(r2, bucket, `${prefix}${p}`, join(dir, p)),
  );
  await pool(paths.filter(isManifest), 4, (p) => put(r2, bucket, `${prefix}${p}`, join(dir, p)));
  return paths.length;
}

async function downloadDir(r2: S3Client, bucket: string, prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "voluma-r2-"));
  const keys: string[] = [];
  for (let token: string | undefined; ; ) {
    const page = await r2.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }),
    );
    for (const object of page.Contents ?? [])
      keys.push((object.Key as string).slice(prefix.length));
    token = page.NextContinuationToken;
    if (!token) break;
  }
  if (keys.length === 0) throw new Error(`nothing under r2:${prefix} in bucket ${bucket}`);
  await pool(keys, 16, async (rel) => {
    relativePathSchema.parse(rel); // the bucket is outside input: no key may leave the folder
    const body = (await r2.send(new GetObjectCommand({ Bucket: bucket, Key: `${prefix}${rel}` })))
      .Body;
    const path = join(dir, rel);
    await mkdir(dirname(path), { recursive: true });
    await pipeline(body as NodeJS.ReadableStream, createWriteStream(path));
  });
  return dir;
}

/** A local folder for `spec`; `done` removes it when it was downloaded. */
export async function localDir(spec: string): Promise<{ dir: string; done: () => Promise<void> }> {
  const prefix = r2Prefix(spec);
  if (!prefix) return { dir: spec, done: async () => {} };
  const { r2, bucket } = r2FromEnv();
  const dir = await downloadDir(r2, bucket, prefix);
  return { dir, done: () => rm(dir, { recursive: true, force: true }) };
}
