/**
 * Operator scripts move a folder of files between disk and R2: `export:run`, `import:run`,
 * `seed:example --backfill` and `r2:put` all take either a local folder or `r2:<prefix>`
 * (`r2:dev/runs/<id>/`). An `r2:` folder is downloaded to a temp folder first, so the code after
 * it reads a plain folder. Reads the R2 settings from the environment (the repo .env).
 */
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
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

/**
 * Stores the file at `key`. Content-addressed keys (`immutable`: evidence by sha256) are skipped
 * when present. Every other key is overwritten unless the stored ETag equals the file's MD5 (what
 * R2 reports for a single-part upload), so a changed file never leaves stale bytes.
 */
export async function put(
  r2: S3Client,
  bucket: string,
  key: string,
  path: string,
  { immutable = false } = {},
): Promise<void> {
  // A buffer, not a stream: the SDK can retry it when the connection drops.
  const body = await readFile(path);
  try {
    const head = await r2.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    if (
      immutable ||
      head.ETag?.replaceAll('"', "") === createHash("md5").update(body).digest("hex")
    )
      return;
  } catch (error) {
    if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode !== 404) {
      throw error;
    }
  }
  await r2.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body }));
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
  console.log(`uploading ${paths.length} files to bucket ${bucket}, prefix ${prefix}`);
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

async function downloadDir(
  r2: S3Client,
  bucket: string,
  prefix: string,
  dir: string,
): Promise<void> {
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
}

/** Runs `use` on a local folder for `spec` (an `r2:` folder is downloaded and removed afterwards). */
export async function withLocalDir<T>(spec: string, use: (dir: string) => Promise<T>): Promise<T> {
  const prefix = r2Prefix(spec);
  if (!prefix) return use(spec);
  const { r2, bucket } = r2FromEnv();
  const dir = await mkdtemp(join(tmpdir(), "voluma-r2-"));
  try {
    await downloadDir(r2, bucket, prefix, dir);
    return await use(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * The `r2:` prefix a script may write to: only under `dev/`, which holds the shared dev data.
 * `runs/…` belongs to the API, and the bucket is shared with staging.
 */
export function devWritePrefix(spec: string): string {
  const prefix = r2Prefix(spec);
  if (!prefix?.startsWith("dev/")) throw new Error(`${spec}: scripts write only to r2:dev/…`);
  return prefix;
}
