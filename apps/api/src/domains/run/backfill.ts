/**
 * The backfill for `seed:example --backfill <dir>`: gives a run recorded before the object outputs
 * existed (ce5a0f21) the objects review shows, as if it had reported them. The directory is made by
 * the run's own prep script (docs repo, `review-site-ce5a0f21/backfill.py`):
 *
 *   backfill.json         { plan, outputs: [report + taskId], checks: [{ taskId, title, text, focus? }] }
 *   files/<sha256>[.ext]  the files the outputs name, by content
 *   assets/<sha256>/      the converter's output for each reported .npy, `manifest.json` last
 *
 * The result is a rewrite of the seeded log, not an append: the fold reads declarations from the
 * recorded plan, and each output has to sit inside its task's last attempt. Every id is derived
 * from the example's id and the output, so seeding again rewrites the same events.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { HeadObjectCommand, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { eventInputSchema, reviewAssetsManifestSchema } from "@voluma/contracts/events";
import { taskIdSchema } from "@voluma/contracts/ids";
import { outputReportSchema } from "@voluma/contracts/output";
import { evidenceKey, reviewAssetKey, sha256Schema } from "@voluma/contracts/r2";
import { focusSchema } from "@voluma/contracts/review";
import { workflowPlanSchema } from "@voluma/contracts/workflow";
import { z } from "zod";
import type { events } from "./schema";

/** An event row before it has its `seq`. */
export type EventRow = Omit<typeof events.$inferSelect, "seq">;

const backfillSchema = z.object({
  plan: workflowPlanSchema,
  outputs: z.array(outputReportSchema.extend({ taskId: taskIdSchema })),
  checks: z.array(
    z.object({
      taskId: taskIdSchema,
      title: z.string().min(1),
      text: z.string().min(1),
      focus: focusSchema.optional(),
    }),
  ),
});
export type Backfill = z.infer<typeof backfillSchema>;

export async function readBackfill(dir: string): Promise<Backfill> {
  return backfillSchema.parse(JSON.parse(await readFile(join(dir, "backfill.json"), "utf8")));
}

type AssetsReady = z.infer<typeof reviewAssetsManifestSchema> & { sourceSha256: string };

async function sha256Of(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function exists(r2: S3Client, bucket: string, key: string, size: number): Promise<boolean> {
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

async function put(r2: S3Client, bucket: string, key: string, path: string): Promise<void> {
  const { size } = await stat(path);
  if (await exists(r2, bucket, key, size)) return;
  await r2.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: createReadStream(path),
      ContentLength: size,
    }),
  );
}

/** Runs `work` over `items`, `limit` at a time. */
async function pool<T>(items: T[], limit: number, work: (item: T) => Promise<void>) {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: limit }, async () => {
      for (let item = queue.shift(); item !== undefined; item = queue.shift()) await work(item);
    }),
  );
}

async function filesUnder(dir: string, prefix = ""): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(join(dir, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...(await filesUnder(dir, path)));
    else found.push(path);
  }
  return found;
}

/**
 * Uploads the directory's files as the example's evidence (checking each file's name is its hash,
 * since the directory crosses a trust boundary) and its assets under `reviewAssetKey`, and returns
 * what each asset directory's manifest says. Objects already stored with the same size are kept.
 */
export async function uploadBackfill(
  r2: S3Client,
  bucket: string,
  exampleId: string,
  dir: string,
): Promise<AssetsReady[]> {
  const names = await readdir(join(dir, "files"));
  await pool(names, 4, async (name) => {
    const sha = sha256Schema.parse(name.split(".")[0]);
    const path = join(dir, "files", name);
    if ((await sha256Of(path)) !== sha) throw new Error(`${path} is not the file its name says`);
    await put(r2, bucket, evidenceKey(exampleId, sha), path);
  });

  const ready: AssetsReady[] = [];
  for (const sourceSha256 of await readdir(join(dir, "assets"))) {
    sha256Schema.parse(sourceSha256);
    const root = join(dir, "assets", sourceSha256);
    const manifest = reviewAssetsManifestSchema.parse(
      JSON.parse(await readFile(join(root, "manifest.json"), "utf8")),
    );
    // "Converted" means manifest.json exists, so it goes last.
    const paths = (await filesUnder(root)).filter((p) => p !== "manifest.json");
    await pool(paths, 16, (p) =>
      put(r2, bucket, reviewAssetKey(exampleId, sourceSha256, p), join(root, p)),
    );
    await put(
      r2,
      bucket,
      reviewAssetKey(exampleId, sourceSha256, "manifest.json"),
      join(root, "manifest.json"),
    );
    ready.push({ ...manifest, sourceSha256 });
  }
  return ready;
}

/**
 * The log with the backfill in it: the recorded plan replaced; each output and To check item
 * placed in its task's last attempt, before that attempt's final `task` event, on the thread that
 * attempt opened on; `assets.ready` for each converted file appended on the root thread.
 * `rows` are the example's events, in order, with ids already renamed to the example's.
 */
export function backfillRows(
  exampleId: string,
  rows: EventRow[],
  backfill: Backfill,
  ready: AssetsReady[],
): EventRow[] {
  const result = rows.map((r) => ({ ...r }));
  const planned = result.find(
    (r) => r.type === "revision.started" && (r.payload as { reason?: string }).reason === "run",
  );
  if (!planned) throw new Error("the run has no first revision.started to put the plan in");
  planned.payload = { ...(planned.payload as object), plan: backfill.plan };

  const added: EventRow[] = [];
  const inserts = new Map<number, EventRow[]>(); // index of the anchor task event -> rows before it
  const place = (
    taskId: string,
    make: (attemptId: string, thread: string, at: Date) => EventRow,
  ) => {
    const opened = result
      .filter(
        (r) => r.type === "attempt.opened" && (r.payload as { taskId: string }).taskId === taskId,
      )
      .at(-1);
    if (!opened) throw new Error(`task ${taskId} has no attempt to put its outputs in`);
    let anchor = -1;
    result.forEach((r, i) => {
      if (r.type === "task" && (r.payload as { attemptId: string }).attemptId === opened.id)
        anchor = i;
    });
    if (anchor < 0) throw new Error(`the last attempt of ${taskId} has no task event`);
    const row = make(opened.id, opened.threadId, (result[anchor] as EventRow).createdAt);
    added.push(row);
    inserts.set(anchor, [...(inserts.get(anchor) ?? []), row]);
  };

  for (const { taskId, ...report } of backfill.outputs) {
    place(taskId, (attemptId, threadId, createdAt) => ({
      id: `${exampleId}:backfill:${taskId}:${report.outputId}`,
      runId: exampleId,
      threadId,
      type: "output",
      payload: { ...report, taskId, attemptId },
      createdAt,
    }));
  }
  backfill.checks.forEach(({ taskId, title, text, focus }, i) => {
    place(taskId, (attemptId, threadId, createdAt) => ({
      id: `${exampleId}:backfill:${taskId}:check:${i}`,
      runId: exampleId,
      threadId,
      type: "checkpoint",
      payload: {
        taskId,
        attemptId,
        text,
        by: { kind: "agent" },
        evidence: [],
        toCheck: { title, ...(focus && { focus }) },
      },
      createdAt,
    }));
  });

  const out = result.flatMap((r, i) => [...(inserts.get(i) ?? []), r]);
  const last = out.at(-1) as EventRow;
  for (const asset of ready) {
    const row: EventRow = {
      id: `${exampleId}:assets:${asset.sourceSha256}`,
      runId: exampleId,
      threadId: `${exampleId}.supervisor`,
      type: "assets.ready",
      payload: asset,
      createdAt: last.createdAt,
    };
    added.push(row);
    out.push(row);
  }
  // The directory is outside input: only what it added is checked against the contract.
  for (const r of added) eventInputSchema.parse({ ...r, createdAt: r.createdAt.toISOString() });
  return out;
}
