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
 * unless every table's deleted count equals the file's. Inputs are shared and stay. The run's study
 * is deleted with its scans when no other run is in it (`import:run` builds a study of one).
 */
import { mkdir, readFile, statfs, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { runEventSchema } from "@voluma/contracts/events";
import { runIdSchema } from "@voluma/contracts/ids";
import { providerCalls } from "@voluma/provider-calls";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { reviewSnapshots } from "../domains/review/schema";
import { databaseUrl } from "../domains/run/operator";
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

await mkdir(out, { recursive: true, mode: 0o700 });
const { bavail, bsize } = await statfs(out);
if (bavail * bsize < MIN_FREE_BYTES) {
  throw new Error(`under 1 GB free where ${out} is; refusing to write the archive`);
}
const text = JSON.stringify(dump);
await writeFile(file, text, { mode: 0o600, flag: "wx" });

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

const deleted = await db.transaction(async (tx) => {
  const [locked] = await tx.select().from(runs).where(eq(runs.id, runId)).for("update");
  if (locked?.state !== "ended") throw new Error(`run ${runId} changed state; nothing deleted`);
  const counts = {
    providerCalls: (
      await tx.delete(providerCalls).where(eq(providerCalls.runId, runId)).returning()
    ).length,
    reviewSnapshots: (
      await tx.delete(reviewSnapshots).where(eq(reviewSnapshots.runId, runId)).returning()
    ).length,
    piMessages: (await tx.delete(piMessages).where(piMessagesOf(runId)).returning()).length,
    threads: (await tx.delete(threads).where(eq(threads.runId, runId)).returning()).length,
    events: (await tx.delete(events).where(eq(events.runId, runId)).returning()).length,
  };
  const diff = Object.entries(counts).filter(
    ([k, n]) => n !== expected[k as keyof typeof expected],
  );
  if (diff.length > 0) {
    throw new Error(
      `deleted counts differ from the archive (${diff.map(([k, n]) => `${k} ${n}`).join(", ")}); rolled back`,
    );
  }
  await tx.delete(runs).where(eq(runs.id, runId));
  const [sibling] = await tx
    .select({ id: runs.id })
    .from(runs)
    .where(eq(runs.studyId, dump.run.studyId))
    .limit(1);
  if (!sibling) {
    await tx.delete(studyScans).where(eq(studyScans.studyId, dump.run.studyId));
    await tx.delete(studies).where(eq(studies.id, dump.run.studyId));
  }
  return { counts, studyDeleted: !sibling };
});
await client.end();
console.log(
  `deleted run ${runId} and ${describeCounts(deleted.counts)}; ${
    deleted.studyDeleted
      ? `study ${dump.run.studyId} and its scans (no other run in it)`
      : "its study stays (other runs in it)"
  }; input ${dump.run.inputId} stays. R2 runs/${runId}/ untouched. Restore: import:run --from ${out}`,
);
