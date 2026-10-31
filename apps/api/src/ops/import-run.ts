/**
 * Operator script: load a run dumped by `export-run.ts` into DATABASE_URL.
 *   pnpm --filter @voluma/api import:run --from <dir|r2:prefix> [--replace] [--remote]
 * Refuses when the run already exists unless `--replace`, which deletes it and its events,
 * pi messages, snapshots and provider calls first. Dumps with study metadata restore the original
 * study and scans, refusing conflicting shared rows. Older dumps get a study of one scan.
 * The study's workflow is the one the dump names (the run's `workflowId` in older dumps, else its study's; their
 * pinned paths may predate a rename), else the bundled workflow at the pinned path. Every event is checked against `runEventSchema` and the ones
 * that fail are listed, with nothing written. The run's input row is added if it is missing.
 * Every row must belong to the run. Writes only to a local database unless `--remote` (see
 * `operator.ts`). Evidence is not copied: it stays in R2 under `runs/<id>/evidence/`, shared by every database.
 */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual, parseArgs } from "node:util";
import { runIdSchema } from "@voluma/contracts/ids";
import { providerCalls } from "@voluma/provider-calls";
import { and, eq, getTableColumns, sql } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { reviewSnapshots } from "../domains/review/schema";
import { eventLock } from "../domains/run/pg-event-log";
import { QUEUE_LOCK } from "../domains/run/pg-queue";
import { events, inputs, piMessages, runs, studies, studyScans } from "../domains/run/schema";
import { databaseUrl } from "./operator";
import { withLocalDir } from "./r2-dir";
import { assertRestorable, countsOf, describeCounts } from "./run-dump";

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
      run: typeof runs.$inferSelect & { workflowId?: string; workflows: { path: string }[] };
      input: typeof inputs.$inferSelect | null;
      study?: typeof studies.$inferSelect;
      studyScans?: (typeof studyScans.$inferSelect)[];
      studyInputs?: (typeof inputs.$inferSelect)[];
      events: { id: string; seq: number; runId: string }[];
      // Dumps made before run-keyed rows also hold `threads` (ignored) and `pi_messages` without `runId`.
      piMessages: { runId?: string }[];
      // Dumps from before these were exported have neither.
      reviewSnapshots?: { runId: string; generation: string }[];
      providerCalls?: { runId: string }[];
    },
);
const runId = runIdSchema.parse(dump.run.id);
const studyId = `study-${runId}`;

const workflow = assertRestorable(dump);

const strays: string[] = [];
if (!dump.study && (dump.studyScans || dump.studyInputs)) {
  throw new Error("dump has study rows without their study");
}
if (dump.study) {
  if (dump.study.id !== dump.run.studyId || dump.study.labId !== dump.run.labId) {
    strays.push("study");
  }
  if (!dump.studyScans?.some((scan) => scan.inputId === dump.run.inputId)) {
    throw new Error("dump is missing the run's study scan");
  }
  for (const scan of dump.studyScans) {
    if (scan.studyId !== dump.study.id) strays.push(`scan of ${scan.studyId}`);
  }
  for (const input of dump.studyInputs ?? []) {
    if (
      input.labId !== dump.run.labId ||
      !dump.studyScans.some((scan) => scan.inputId === input.id)
    ) {
      strays.push(`input ${input.id}`);
    }
  }
}
if (dump.input && (dump.input.id !== dump.run.inputId || dump.input.labId !== dump.run.labId)) {
  strays.push("input");
}
if (strays.length > 0) {
  throw new Error(`${strays.length} rows are not run ${runId}'s: ${strays.slice(0, 5).join(", ")}`);
}

const client = postgres(url);
const db = drizzle(client, { casing: "snake_case" });
function sameSharedRow(name: string, actual: unknown, expected: unknown) {
  // Old dumps may omit columns added since they were written; compare the fields they have.
  const saved = JSON.parse(JSON.stringify(actual ?? {}));
  const wanted = JSON.parse(JSON.stringify(expected));
  if (Object.keys(wanted).some((key) => !isDeepStrictEqual(saved[key], wanted[key]))) {
    throw new Error(`${name} conflicts with existing shared data; nothing imported`);
  }
}
await db.transaction(async (tx) => {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${QUEUE_LOCK})`);
  await eventLock(tx, runId);
  const [existing] = await tx
    .select({ studyId: runs.studyId })
    .from(runs)
    .where(eq(runs.id, runId))
    .for("update");
  if (existing && !values.replace) throw new Error(`run ${runId} exists; pass --replace`);
  await tx.delete(providerCalls).where(eq(providerCalls.runId, runId));
  await tx.delete(reviewSnapshots).where(eq(reviewSnapshots.runId, runId));
  await tx.delete(piMessages).where(eq(piMessages.runId, runId));
  await tx.delete(events).where(eq(events.runId, runId));
  await tx.delete(runs).where(eq(runs.id, runId));

  for (const input of dump.studyInputs ?? (dump.input ? [dump.input] : [])) {
    await tx.insert(inputs).values(revive(inputs, input)).onConflictDoNothing();
    const [stored] = await tx.select().from(inputs).where(eq(inputs.id, input.id));
    sameSharedRow(`input ${input.id}`, stored, input);
  }
  const run = revive(runs, dump.run);
  // Import starts a new local lifetime, even when restoring an earlier dump of this run.
  // A screenshot validated before replacement must not publish into the restored history.
  run.generation = randomUUID();
  const [runInput] = await tx.select().from(inputs).where(eq(inputs.id, run.inputId));
  if (!runInput || runInput.labId !== run.labId)
    throw new Error(`missing or conflicting run input ${run.inputId}`);
  const keep = existing?.studyId;
  if (dump.study) {
    await tx.insert(studies).values(revive(studies, dump.study)).onConflictDoNothing();
    const [stored] = await tx.select().from(studies).where(eq(studies.id, dump.study.id));
    sameSharedRow(`study ${dump.study.id}`, stored, dump.study);
    for (const scan of dump.studyScans ?? []) {
      const [input] = await tx.select().from(inputs).where(eq(inputs.id, scan.inputId));
      if (!input || input.labId !== run.labId)
        throw new Error(`missing study input ${scan.inputId}`);
      await tx.insert(studyScans).values(scan).onConflictDoNothing();
      const [storedScan] = await tx
        .select()
        .from(studyScans)
        .where(and(eq(studyScans.studyId, scan.studyId), eq(studyScans.inputId, scan.inputId)));
      sameSharedRow(`scan ${scan.inputId}`, storedScan, scan);
    }
    run.studyId = dump.study.id;
  } else if (!keep) {
    // Legacy dumps have no study metadata. Never replace a colliding shared study.
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
    run.studyId = studyId;
  } else {
    const [study] = await tx.select().from(studies).where(eq(studies.id, keep));
    sameSharedRow(`study ${keep}`, study, {
      labId: run.labId,
      workflowId: workflow.id,
      example: run.example ?? false,
    });
    const [scan] = await tx
      .select()
      .from(studyScans)
      .where(and(eq(studyScans.studyId, keep), eq(studyScans.inputId, run.inputId)));
    if (!scan) throw new Error(`study ${keep} has no scan for input ${run.inputId}`);
    run.studyId = keep;
  }
  await tx.insert(runs).values(run);
  // Postgres caps a statement's parameters, so insert in batches.
  const insertAll = async <T extends PgTable>(table: T, rows: unknown[]) => {
    for (let i = 0; i < rows.length; i += 500) {
      await tx.insert(table).values(rows.slice(i, i + 500).map((r) => revive(table, r)));
    }
  };
  await insertAll(events, dump.events);
  await insertAll(
    piMessages,
    dump.piMessages.map((m) => ({ ...m, runId })),
  );
  await insertAll(
    reviewSnapshots,
    (dump.reviewSnapshots ?? []).map((snapshot) => ({
      ...snapshot,
      generation:
        snapshot.generation === dump.run.generation ? run.generation : snapshot.generation,
    })),
  );
  await insertAll(providerCalls, dump.providerCalls ?? []);
});
console.log(`run ${runId}: ${describeCounts(countsOf(dump))} loaded`);
await client.end();
