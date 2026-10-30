/**
 * Operator script: copy one ended run's database rows to this machine, check the copy, then
 * delete them from DATABASE_URL (else this worktree's `pnpm dev` database), so a full
 * database sheds runs we have looked at without losing them.
 *   pnpm --filter @voluma/api archive:run --id <runId> [--out <dir>] [--remote]
 * `--out` defaults to ~/.local/share/voluma-backups/runs/<runId>/ (dirs 0700, `run.json` 0600).
 * Refuses an example run, a run that has not ended, an `--out` that already holds a `run.json`,
 * and under 1 GB free disk. Only rows move: the run's R2 files under `runs/<id>/` stay put, so
 * `import:run --from <out>` restores the run whole. Writes to a non-local database only with `--remote`.
 *
 * The copy must parse, its events must pass `runEventSchema` (as `import:run` demands), and
 * its file bytes must equal what was read. The delete runs in one transaction that rolls back
 * unless every deleted row equals the file's. Inputs are shared and stay. The run's study
 * is deleted with its scans when no other run is in it; import restores their original metadata.
 */
import { mkdir, open, readFile, statfs } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual, parseArgs } from "node:util";
import { runEventSchema } from "@voluma/contracts/events";
import { runIdSchema } from "@voluma/contracts/ids";
import { providerCalls } from "@voluma/provider-calls";
import { workflowById } from "@voluma/workflow/bundled";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { reviewSnapshots } from "../domains/review/schema";
import { databaseUrl } from "../domains/run/operator";
import { eventLock } from "../domains/run/pg-event-log";
import { QUEUE_LOCK } from "../domains/run/pg-queue";
import { events, piMessages, runs, studies, studyScans, threads } from "../domains/run/schema";
import { countsOf, describeCounts, piMessagesOf, readDump } from "./run-dump";

const MIN_FREE_BYTES = 1024 ** 3;

const { values } = parseArgs({
  options: { id: { type: "string" }, out: { type: "string" }, remote: { type: "boolean" } },
});
if (!values.id) throw new Error("usage: archive:run --id <runId> [--out <dir>] [--remote]");
const runId = runIdSchema.parse(values.id);
const out = values.out ?? join(homedir(), ".local/share/voluma-backups/runs", runId);
const file = join(out, "run.json");

const client = postgres(databaseUrl({ writes: true, remote: values.remote }));
const db = drizzle(client, { casing: "snake_case" });
const dump = await readDump(db, runId);
if (dump.run.example) throw new Error(`run ${runId} is an example; archive refuses examples`);
if (dump.run.state !== "ended") {
  throw new Error(`run ${runId} is ${dump.run.state}; archive only a run that has ended`);
}
if (dump.providerCalls.some((call) => call.status === "open")) {
  throw new Error(`run ${runId} has provider calls still in flight; nothing deleted`);
}
if (
  !dump.input ||
  !dump.study ||
  dump.input.labId !== dump.run.labId ||
  dump.study.labId !== dump.run.labId ||
  dump.studyInputs.some((input) => input.labId !== dump.run.labId) ||
  !workflowById(dump.study.workflowId) ||
  !dump.studyScans.some((scan) => scan.inputId === dump.run.inputId) ||
  dump.studyScans.some((scan) => !dump.studyInputs.some((input) => input.id === scan.inputId))
) {
  throw new Error(
    `run ${runId} has missing inputs, study scans or an unknown workflow; cannot restore`,
  );
}

await mkdir(out, { recursive: true, mode: 0o700 });
const { bavail, bsize } = await statfs(out);
if (bavail * bsize < MIN_FREE_BYTES) {
  throw new Error(`under 1 GB free where ${out} is; refusing to write the archive`);
}
const text = JSON.stringify(dump);
const handle = await open(file, "wx", 0o600);
try {
  await handle.writeFile(text);
  await handle.sync();
} finally {
  await handle.close();
}
// File data and every newly created directory entry must survive before the DB commits.
for (let dir = resolve(out); ; dir = dirname(dir)) {
  const directory = await open(dir, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
  if (dirname(dir) === dir) break;
}

// Read the copy back from disk, not from memory.
const copy = JSON.parse(await readFile(file, "utf8")) as typeof dump;
if (JSON.stringify(copy) !== text) throw new Error(`${file} differs from the rows read`);
const failed = copy.events.filter((e) => !runEventSchema.safeParse(e).success);
if (failed.length > 0) {
  throw new Error(
    `${failed.length} events fail runEventSchema, so import:run would refuse ${file}`,
  );
}
const expected = countsOf(copy);
console.log(`wrote ${file} (${(text.length / 1e6).toFixed(1)} MB): ${describeCounts(expected)}`);

function matches(name: string, actual: unknown[], archived: unknown[]) {
  // RETURNING has no ordering guarantee; JSON also normalizes the database's Dates.
  const rows = (values: unknown[]) => values.map((row) => JSON.stringify(row)).sort();
  if (!isDeepStrictEqual(rows(actual), rows(archived))) {
    throw new Error(`${name} rows differ from the archive; rolled back`);
  }
}

const deleted = await db.transaction(async (tx) => {
  // Same order as lifecycle writes. The queue lock also excludes new sibling runs.
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${QUEUE_LOCK})`);
  await eventLock(tx, runId);
  const [locked] = await tx.select().from(runs).where(eq(runs.id, runId)).for("update");
  matches("run", locked ? [locked] : [], [copy.run]);
  const rows = {
    providerCalls: await tx.delete(providerCalls).where(eq(providerCalls.runId, runId)).returning(),
    reviewSnapshots: await tx
      .delete(reviewSnapshots)
      .where(eq(reviewSnapshots.runId, runId))
      .returning(),
    piMessages: await tx.delete(piMessages).where(piMessagesOf(runId)).returning(),
    threads: await tx.delete(threads).where(eq(threads.runId, runId)).returning(),
    events: await tx.delete(events).where(eq(events.runId, runId)).returning(),
  };
  for (const name of Object.keys(rows) as (keyof typeof rows)[]) {
    matches(name, rows[name], copy[name]);
  }
  await tx.delete(runs).where(eq(runs.id, runId));
  const [sibling] = await tx
    .select({ id: runs.id })
    .from(runs)
    .where(eq(runs.studyId, dump.run.studyId))
    .limit(1);
  if (!sibling) {
    matches(
      "study scans",
      await tx.delete(studyScans).where(eq(studyScans.studyId, dump.run.studyId)).returning(),
      copy.studyScans,
    );
    matches("study", await tx.delete(studies).where(eq(studies.id, dump.run.studyId)).returning(), [
      copy.study,
    ]);
  }
  return { counts: countsOf(rows), studyDeleted: !sibling };
});
await client.end();
console.log(
  `deleted run ${runId} and ${describeCounts(deleted.counts)}; ${
    deleted.studyDeleted
      ? `study ${dump.run.studyId} and its scans (no other run in it)`
      : "its study stays (other runs in it)"
  }; input ${dump.run.inputId} stays. R2 runs/${runId}/ untouched. Restore: import:run --from ${out}`,
);
