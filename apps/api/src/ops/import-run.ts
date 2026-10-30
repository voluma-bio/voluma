/**
 * Operator script: load a run dumped by `export-run.ts` into DATABASE_URL.
 *   pnpm --filter @voluma/api import:run --from <dir|r2:prefix> [--replace] [--remote]
 * Refuses when the run already exists unless `--replace`, which deletes it and its events,
 * threads, pi messages, snapshots and provider calls first. The run's archived study and its
 * scan rows come back when the study id is free and every scan's input exists here; otherwise the
 * run gets its own study of one scan (`study-<runId>`, named after the scan) and the output says
 * so. The workflow is the one the dump names (the run's `workflowId` in older dumps, else its
 * study's; pinned paths may predate a rename), else the bundled workflow at the pinned path.
 * `assertRestorable` (`run-dump.ts`) vets the dump before anything is written: every row belongs
 * to the run, every event passes `runEventSchema`. The run's input row is added if it is missing. Writes only to a local database unless `--remote` (see
 * `operator.ts`). Evidence is not copied: it stays in R2 under `runs/<id>/evidence/`, shared by every database.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { runIdSchema } from "@voluma/contracts/ids";
import { providerCalls } from "@voluma/provider-calls";
import { eq, getTableColumns, inArray } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { reviewSnapshots } from "../domains/review/schema";
import {
  events,
  inputs,
  piMessages,
  runs,
  studies,
  studyScans,
  threads,
} from "../domains/run/schema";
import { databaseUrl } from "./operator";
import { withLocalDir } from "./r2-dir";
import { assertRestorable, countsOf, describeCounts, piMessagesOf } from "./run-dump";

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
      study?: { id: string; workflowId: string };
      studyScans?: { inputId: string }[];
      events: { id: string; seq: number; runId: string }[];
      threads: { runId: string }[];
      piMessages: { threadId: string }[];
      // Dumps from before these were exported have neither.
      reviewSnapshots?: { runId: string }[];
      providerCalls?: { runId: string }[];
    },
);
const runId = runIdSchema.parse(dump.run.id);
const fallbackStudyId = `study-${runId}`;
let studyNote = "";

const workflow = assertRestorable(dump);

const client = postgres(url);
const db = drizzle(client, { casing: "snake_case" });
await db.transaction(async (tx) => {
  const [existing] = await tx
    .select({ studyId: runs.studyId })
    .from(runs)
    .where(eq(runs.id, runId));
  if (existing && !values.replace) throw new Error(`run ${runId} exists; pass --replace`);
  await tx.delete(providerCalls).where(eq(providerCalls.runId, runId));
  await tx.delete(reviewSnapshots).where(eq(reviewSnapshots.runId, runId));
  await tx.delete(piMessages).where(piMessagesOf(runId));
  await tx.delete(threads).where(eq(threads.runId, runId));
  await tx.delete(events).where(eq(events.runId, runId));
  await tx.delete(runs).where(eq(runs.id, runId));

  if (dump.input) await tx.insert(inputs).values(revive(inputs, dump.input)).onConflictDoNothing();
  const run = revive(runs, dump.run);
  // A replaced run keeps the study it is in. Otherwise the archived study and its scans come
  // back when the study id is free and every scan's input exists; else the run gets a study of one.
  const keep = existing?.studyId;
  let studyId = keep;
  if (!keep) {
    const archived = dump.study;
    const scanInputs = (dump.studyScans ?? []).map((sc) => sc.inputId);
    const inputsHere = scanInputs.length
      ? await tx.select({ id: inputs.id }).from(inputs).where(inArray(inputs.id, scanInputs))
      : [];
    const taken = archived
      ? (await tx.select({ id: studies.id }).from(studies).where(eq(studies.id, archived.id)))
          .length > 0
      : false;
    const missing = scanInputs.filter((id) => !inputsHere.some((i) => i.id === id));
    if (archived && !taken && missing.length === 0 && scanInputs.length > 0) {
      await tx.insert(studies).values(revive(studies, { ...archived, workflowId: workflow.id }));
      await tx.insert(studyScans).values((dump.studyScans ?? []).map((r) => revive(studyScans, r)));
      studyId = archived.id;
      studyNote = `restored study ${studyId} and its scans`;
    } else {
      studyNote = !archived
        ? "the dump holds no study, so the run got a study of one"
        : taken
          ? `study ${archived.id} already exists, so the run got a study of one`
          : `the dump's study needs inputs missing here (${missing.join(", ")}), so the run got a study of one`;
      studyId = fallbackStudyId;
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
  }
  run.studyId = studyId as string;
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
  await insertAll(reviewSnapshots, dump.reviewSnapshots ?? []);
  await insertAll(providerCalls, dump.providerCalls ?? []);
});
console.log(
  `run ${runId}: ${describeCounts(countsOf(dump))} loaded${studyNote ? `; ${studyNote}` : ""}`,
);
await client.end();
