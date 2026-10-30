/**
 * Operator script: dump one run's rows from DATABASE_URL (else this worktree's `pnpm dev` database), so another database can load them
 * (`import-run.ts`).
 *   pnpm --filter @voluma/api export:run --id <runId> --out <dir|r2:dev/prefix>
 * Writes `run.json`: the run, its input, events, threads and pi messages (what `seed:example` reads).
 * Evidence stays in R2 under `runs/<id>/evidence/`; nothing there is copied.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { runIdSchema } from "@voluma/contracts/ids";
import { asc, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { databaseUrl } from "./operator";
import { devWritePrefix, r2FromEnv, r2Prefix, uploadDir } from "./r2-dir";
import { events, inputs, piMessages, runs, threads } from "./schema";

const { values } = parseArgs({ options: { id: { type: "string" }, out: { type: "string" } } });
if (!values.id || !values.out)
  throw new Error("usage: export:run --id <runId> --out <dir|r2:prefix>");
const runId = runIdSchema.parse(values.id);
const prefix = r2Prefix(values.out) && devWritePrefix(values.out);
const out = prefix ? await mkdtemp(join(tmpdir(), "voluma-export-")) : values.out;

const client = postgres(databaseUrl({ writes: false }));
const db = drizzle(client, { casing: "snake_case" });
const [run] = await db.select().from(runs).where(eq(runs.id, runId));
if (!run) throw new Error(`run ${runId} not found`);
const [input] = await db.select().from(inputs).where(eq(inputs.id, run.inputId));
const dump = {
  run,
  input,
  events: await db.select().from(events).where(eq(events.runId, runId)).orderBy(asc(events.seq)),
  threads: await db.select().from(threads).where(eq(threads.runId, runId)),
  piMessages: await db
    .select()
    .from(piMessages)
    .where(sql`starts_with(${piMessages.threadId}, ${`${runId}.`})`)
    .orderBy(asc(piMessages.threadId), asc(piMessages.idx)),
};
await client.end();

await mkdir(out, { recursive: true });
await writeFile(join(out, "run.json"), JSON.stringify(dump));
if (prefix) {
  const { r2, bucket } = r2FromEnv();
  await uploadDir(r2, bucket, out, prefix);
  await rm(out, { recursive: true, force: true });
}
console.log(
  `run ${runId}: ${dump.events.length} events, ${dump.threads.length} threads, ${dump.piMessages.length} pi messages -> ${values.out}`,
);
