/**
 * Operator script: dump one run's rows from DATABASE_URL (else this worktree's `pnpm dev` database), so another database can load them
 * (`import-run.ts`).
 *   pnpm --filter @voluma/api export:run --id <runId> --out <dir|r2:dev/prefix>
 * Writes `run.json` (`run-dump.ts`; what `import:run` reads).
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { runIdSchema } from "@voluma/contracts/ids";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { databaseUrl } from "./operator";
import { devWritePrefix, r2FromEnv, r2Prefix, uploadDir } from "./r2-dir";
import { countsOf, describeCounts, readDump } from "./run-dump";

const { values } = parseArgs({ options: { id: { type: "string" }, out: { type: "string" } } });
if (!values.id || !values.out)
  throw new Error("usage: export:run --id <runId> --out <dir|r2:prefix>");
const runId = runIdSchema.parse(values.id);
const prefix = r2Prefix(values.out) && devWritePrefix(values.out);
const out = prefix ? await mkdtemp(join(tmpdir(), "voluma-export-")) : values.out;

const client = postgres(databaseUrl({ writes: false }));
const dump = await readDump(drizzle(client, { casing: "snake_case" }), runId);
await client.end();

await mkdir(out, { recursive: true });
await writeFile(join(out, "run.json"), JSON.stringify(dump));
if (prefix) {
  const { store, bucket } = r2FromEnv();
  await uploadDir(store, bucket, out, prefix);
  await rm(out, { recursive: true, force: true });
}
console.log(`run ${runId}: ${describeCounts(countsOf(dump))} -> ${values.out}`);
