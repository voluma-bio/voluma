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
 * One repeatable-read transaction does it all: lock the run, read its rows, check them with
 * `assertRestorable` (what `import:run` demands), write the file and fsync it and its directory,
 * read it back, then delete and commit. The file is exactly what was deleted; a concurrent
 * change to the run's rows fails the transaction instead. It also rolls back unless every
 * table's deleted count equals the file's. Inputs are shared and stay. The run's study and its
 * scans are deleted when no other run is in it; `import:run` restores them.
 */
import { mkdir, open, readFile, statfs } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { runIdSchema } from "@voluma/contracts/ids";
import { providerCalls } from "@voluma/provider-calls";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { reviewSnapshots } from "../domains/review/schema";
import { events, piMessages, runs, studies, studyScans, threads } from "../domains/run/schema";
import { databaseUrl } from "./operator";
import { assertRestorable, countsOf, describeCounts, piMessagesOf, readDump } from "./run-dump";

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

await mkdir(out, { recursive: true, mode: 0o700 });
const { bavail, bsize } = await statfs(out);
if (bavail * bsize < MIN_FREE_BYTES) {
  throw new Error(`under 1 GB free where ${out} is; refusing to write the archive`);
}

const result = await db.transaction(
  async (tx) => {
    const [locked] = await tx.select().from(runs).where(eq(runs.id, runId)).for("update");
    if (!locked) throw new Error(`run ${runId} not found`);
    if (locked.example) throw new Error(`run ${runId} is an example; archive refuses examples`);
    if (locked.state !== "ended") {
      throw new Error(`run ${runId} is ${locked.state}; archive only a run that has ended`);
    }
    const dump = await readDump(tx, runId);
    const text = JSON.stringify(dump);
    // Check what the file will hold: JSON turns the rows' Dates into strings.
    assertRestorable(JSON.parse(text));
    const handle = await open(file, "wx", 0o600).catch((e) => {
      if (e.code === "EEXIST") {
        throw new Error(`${file} exists (an earlier attempt?); remove it or pass another --out`);
      }
      throw e;
    });
    try {
      await handle.writeFile(text);
      await handle.sync();
    } finally {
      await handle.close();
    }
    // The file's name is durable only once its directory is.
    const dir = await open(out, "r");
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }

    // Read the copy back from disk, not from memory.
    const copy = JSON.parse(await readFile(file, "utf8")) as typeof dump;
    if (JSON.stringify(copy) !== text) throw new Error(`${file} differs from the rows read`);
    const expected = countsOf(copy);
    console.log(
      `wrote ${file} (${(Buffer.byteLength(text) / 1e6).toFixed(1)} MB): ${describeCounts(expected)}`,
    );

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
        `deleted counts differ from the archive (${diff.map(([k, n]) => `${k} ${n}`).join(", ")}); rolled back. ${file} was written; remove it before retrying`,
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
    return { counts, dump, studyDeleted: !sibling };
  },
  { isolationLevel: "repeatable read" },
);
await client.end();
const { dump } = result;
console.log(
  `deleted run ${runId} and ${describeCounts(result.counts)}; ${
    result.studyDeleted
      ? `study ${dump.run.studyId} and its scans (no other run in it)`
      : "its study stays (other runs in it)"
  }; input ${dump.run.inputId} stays. R2 runs/${runId}/ untouched. Restore: import:run --from ${out}`,
);
