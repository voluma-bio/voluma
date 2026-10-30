/**
 * Operator script: load a run dumped by `export-run.ts` into DATABASE_URL.
 *   pnpm --filter @voluma/api import:run --from <dir|r2:prefix> [--replace] [--remote]
 * Refuses when the run already exists unless `--replace`, which deletes it and its events,
 * threads and pi messages first. The run gets its own study of one scan (`study-<runId>`, named
 * after the scan, as the migration that introduced studies did). The study's workflow is the dump's own `workflowId` when it has one (older dumps do, and
 * their pinned paths may predate a rename), else the bundled workflow at the pinned path. Every event is checked against `runEventSchema` and the ones
 * that fail are listed, with nothing written. The run's input row is added if it is missing.
 * Every row must belong to the run. Writes only to a local database unless `--remote` (see
 * `operator.ts`). Evidence is not copied: it stays in R2 under `runs/<id>/evidence/`, shared by every database.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { runEventSchema } from "@voluma/contracts/events";
import { runIdSchema } from "@voluma/contracts/ids";
import { catalog, workflowById } from "@voluma/workflow/bundled";
import { eq, getTableColumns, sql } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import {
  events,
  inputs,
  piMessages,
  runs,
  studies,
  studyScans,
  threads,
} from "../src/domains/run/schema";
import { databaseUrl } from "./operator";
import { withLocalDir } from "./r2-dir";

const { values } = parseArgs({
  options: { from: { type: "string" }, replace: { type: "boolean" }, remote: { type: "boolean" } },
});
if (!values.from)
  throw new Error("usage: import:run --from <dir|r2:prefix> [--replace] [--remote]");

/** The dump is JSON, so its timestamps are strings; Drizzle wants Dates. */
function revive<T extends PgTable>(table: T, row: unknown): T["$inferInsert"] {
  const out = { ...(row as Record<string, unknown>) };
  for (const [key, column] of Object.entries(getTableColumns(table))) {
    if (column.dataType === "date" && typeof out[key] === "string") out[key] = new Date(out[key]);
  }
  return out as T["$inferInsert"];
}

const url = databaseUrl({ writes: true, remote: values.remote });
const dump = await withLocalDir(
  values.from,
  async (dir) =>
    JSON.parse(await readFile(join(dir, "run.json"), "utf8")) as {
      // `workflowId` is the column dumps carried before studies took it over.
      run: { id: string; workflowId?: string; workflows: { path: string }[] };
      input: { id: string; name: string } | null;
      events: { id: string; seq: number; runId: string }[];
      threads: { runId: string }[];
      piMessages: { threadId: string }[];
    },
);
const runId = runIdSchema.parse(dump.run.id);
const studyId = `study-${runId}`;

const workflowPath = dump.run.workflows[0]?.path;
const workflow =
  (dump.run.workflowId ? workflowById(dump.run.workflowId) : undefined) ??
  Object.values(catalog).find((w) => w.path === workflowPath);
if (!workflow) {
  throw new Error(
    `run ${runId} used ${dump.run.workflowId ?? workflowPath}, which is not a bundled workflow`,
  );
}

const strays = [
  ...dump.events.filter((e) => e.runId !== runId).map((e) => `event ${e.id}`),
  ...dump.threads.filter((t) => t.runId !== runId).map((t) => `thread of ${t.runId}`),
  ...dump.piMessages.filter((m) => !m.threadId.startsWith(`${runId}.`)).map((m) => m.threadId),
];
if (strays.length > 0) {
  throw new Error(`${strays.length} rows are not run ${runId}'s: ${strays.slice(0, 5).join(", ")}`);
}

const failed = dump.events.flatMap((e) => {
  const result = runEventSchema.safeParse(e);
  return result.success ? [] : [`seq ${e.seq} (${e.id}): ${result.error.issues[0]?.message}`];
});
if (failed.length > 0) {
  throw new Error(`${failed.length} events fail runEventSchema:\n${failed.join("\n")}`);
}

const client = postgres(url);
const db = drizzle(client, { casing: "snake_case" });
await db.transaction(async (tx) => {
  const [existing] = await tx
    .select({ studyId: runs.studyId })
    .from(runs)
    .where(eq(runs.id, runId));
  if (existing && !values.replace) throw new Error(`run ${runId} exists; pass --replace`);
  await tx.delete(piMessages).where(sql`starts_with(${piMessages.threadId}, ${`${runId}.`})`);
  await tx.delete(threads).where(eq(threads.runId, runId));
  await tx.delete(events).where(eq(events.runId, runId));
  await tx.delete(runs).where(eq(runs.id, runId));

  if (dump.input) await tx.insert(inputs).values(revive(inputs, dump.input)).onConflictDoNothing();
  const run = revive(runs, dump.run);
  // A replaced run keeps the study it is in; anything else gets a study of one.
  const keep = existing?.studyId;
  if (!keep) {
    await tx.delete(studyScans).where(eq(studyScans.studyId, studyId));
    await tx.delete(studies).where(eq(studies.id, studyId));
    await tx.insert(studies).values({
      id: studyId,
      labId: run.labId,
      name: dump.input?.name ?? runId,
      workflowId: workflow.id,
      createdBy: run.startedBy,
      example: run.example ?? false,
      createdAt: run.createdAt,
    });
    await tx.insert(studyScans).values({
      studyId,
      inputId: run.inputId,
      subject: dump.input?.name ?? runId,
      attributes: {},
      position: 0,
    });
  }
  run.studyId = keep ?? studyId;
  await tx.insert(runs).values(run);
  // Postgres caps a statement's parameters, so insert in batches.
  const insertAll = async <T extends PgTable>(table: T, rows: unknown[]) => {
    for (let i = 0; i < rows.length; i += 500) {
      await tx.insert(table).values(rows.slice(i, i + 500).map((r) => revive(table, r)));
    }
  };
  await insertAll(events, dump.events);
  await insertAll(threads, dump.threads);
  await insertAll(piMessages, dump.piMessages);
});
console.log(
  `run ${runId}: ${dump.events.length} events, ${dump.threads.length} threads, ${dump.piMessages.length} pi messages loaded`,
);
await client.end();
