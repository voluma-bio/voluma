/**
 * Operator script: load a run dumped by `export-run.ts` into DATABASE_URL.
 *   pnpm --filter @voluma/api import:run --from <dir|r2:prefix> [--replace]
 * Refuses when the run already exists unless `--replace`, which deletes it and its events,
 * threads and pi messages first. Every event is checked against `runEventSchema` and the ones
 * that fail are listed, with nothing written. The run's input row is added if it is missing.
 * Evidence is not copied: it stays in R2 under `runs/<id>/evidence/`, shared by every database.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { runEventSchema } from "@voluma/contracts/events";
import { runIdSchema } from "@voluma/contracts/ids";
import { eq, getTableColumns, sql } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { localDir, required } from "./r2-dir";
import { events, inputs, piMessages, runs, threads } from "./schema";

const { values } = parseArgs({
  options: { from: { type: "string" }, replace: { type: "boolean" } },
});
if (!values.from) throw new Error("usage: import:run --from <dir|r2:prefix> [--replace]");

/** The dump is JSON, so its timestamps are strings; Drizzle wants Dates. */
function revive<T extends PgTable>(table: T, row: unknown): T["$inferInsert"] {
  const out = { ...(row as Record<string, unknown>) };
  for (const [key, column] of Object.entries(getTableColumns(table))) {
    if (column.dataType === "date" && typeof out[key] === "string") out[key] = new Date(out[key]);
  }
  return out as T["$inferInsert"];
}

const source = await localDir(values.from);
const dump = JSON.parse(await readFile(join(source.dir, "run.json"), "utf8")) as {
  run: { id: string };
  input: unknown;
  events: { id: string; seq: number }[];
  threads: unknown[];
  piMessages: unknown[];
};
await source.done();
const runId = runIdSchema.parse(dump.run.id);

const failed = dump.events.flatMap((e) => {
  const result = runEventSchema.safeParse(e);
  return result.success ? [] : [`seq ${e.seq} (${e.id}): ${result.error.issues[0]?.message}`];
});
if (failed.length > 0) {
  throw new Error(`${failed.length} events fail runEventSchema:\n${failed.join("\n")}`);
}

const client = postgres(required("DATABASE_URL"));
const db = drizzle(client, { casing: "snake_case" });
await db.transaction(async (tx) => {
  const [existing] = await tx.select({ id: runs.id }).from(runs).where(eq(runs.id, runId));
  if (existing && !values.replace) throw new Error(`run ${runId} exists; pass --replace`);
  await tx.delete(piMessages).where(sql`starts_with(${piMessages.threadId}, ${`${runId}.`})`);
  await tx.delete(threads).where(eq(threads.runId, runId));
  await tx.delete(events).where(eq(events.runId, runId));
  await tx.delete(runs).where(eq(runs.id, runId));

  if (dump.input) await tx.insert(inputs).values(revive(inputs, dump.input)).onConflictDoNothing();
  await tx.insert(runs).values(revive(runs, dump.run));
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
