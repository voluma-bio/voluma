/**
 * Operator script: copy a finished run into an example run in the Demo organization.
 *   pnpm --filter @voluma/api seed:example --from <runId> [--id <exampleRunId>] [--backfill <dir|r2:prefix>] [--remote]
 * Reads DATABASE_URL (else this worktree's `pnpm dev` database), GUEST_ORGANIZATION_ID (the Demo organization) and the R2 settings (the repo .env, or the host's variables).
 *
 * The example gets the source's events and history under its own run id (event ids, thread ids
 * and payloads are copied verbatim: rows are keyed by run), `startedBy: "voluma-examples"`, `example: true`,
 * and the Demo org's reference-scan input. It belongs to its own study of one scan
 * (`study-<exampleId>`, `example: true`), replaced with it. The source's evidence, review assets, message snapshots (`scratch/person/`) and `outputs/` objects in R2 are copied
 * under the example's own prefix (`evidenceKey` builds a key from the run being read, so an
 * example can't point at another run's files). `--backfill` adds the objects a run recorded before
 * they existed (`backfill.ts`). Re-seeding the same `--id` replaces the
 * example, and nothing else: an existing run that isn't an example is refused. The source must be a completed `voluma` run on a reference scan: a visitor run's
 * outputs are untrusted (`@voluma/contracts/run`), and an example's scan is shown to everyone.
 */
import { parseArgs } from "node:util";
import { runIdSchema } from "@voluma/contracts/ids";
import {
  evidencePrefix,
  outputsPrefix,
  reviewAssetPrefix,
  runPrefix,
  scratchPrefix,
} from "@voluma/contracts/r2";
import { deletePrefix } from "@voluma/object-store";
import { asc, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import {
  EXAMPLES_OPERATOR,
  events,
  inputs,
  piMessages,
  referenceInput,
  runs,
  studies,
  studyScans,
} from "../domains/run/schema";
import { backfillRows, readBackfill, uploadBackfill } from "./backfill";
import { databaseUrl } from "./operator";
import { r2FromEnv, required, withLocalDir } from "./r2-dir";

const { values } = parseArgs({
  options: {
    from: { type: "string" },
    id: { type: "string" },
    backfill: { type: "string" },
    remote: { type: "boolean" },
  },
});
if (!values.from)
  throw new Error(
    "usage: seed:example --from <runId> [--id <exampleRunId>] [--backfill <dir|r2:prefix>] [--remote]",
  );
const source = runIdSchema.parse(values.from);
const stagingId = `example-${source}`;
if (!values.remote && values.id === stagingId) {
  throw new Error(`${stagingId} is the example staging reads; pass --remote to seed it`);
}
const exampleId = runIdSchema.parse(
  values.id ?? (values.remote ? stagingId : `example-local-${source}`),
);
// `outputs/` is overwritten below, and the bucket is shared with staging.
if (!values.remote && !exampleId.startsWith("example-local-")) {
  throw new Error(`without --remote the id must start with example-local- (got ${exampleId})`);
}
const studyId = `study-${exampleId}`;
const demoLabId = required("GUEST_ORGANIZATION_ID");

const client = postgres(databaseUrl({ writes: true, remote: values.remote }));
const db = drizzle(client, { casing: "snake_case" });
const { store, bucket } = r2FromEnv();
console.log(`example ${exampleId} -> bucket ${bucket}, prefix ${runPrefix(exampleId)}`);

// Copies every object under one of the source run's prefixes to the same place under the
// example's. Evidence is content-addressed and never overwritten, so a repeat copy is harmless.
// `review/` holds the volumes and meshes the copied `assets.ready` events point at, and
// `scratch/person/` the view snapshots of the copied messages (`messageSnapshotKey`). `outputs/` is
// copied so the example is a whole run for the walkthrough's clone flow. These are emptied first,
// so a re-seed leaves no object of the previous one; a seed that fails partway leaves the example's
// 3D view broken until it is rerun.
async function copyPrefix(
  prefixOf: (runId: string) => string,
  { replace = false } = {},
): Promise<number> {
  const fromPrefix = prefixOf(source);
  if (replace) {
    await deletePrefix(store, prefixOf(exampleId));
  }
  const { objects } = await store.list(fromPrefix);
  for (const object of objects) {
    await store.copy(object.key, `${prefixOf(exampleId)}${object.key.slice(fromPrefix.length)}`);
  }
  const copied = objects.length;
  return copied;
}

// Read and check everything, then upload to R2, then write the database in one short transaction.
const [src] = await db
  .select({ run: runs, input: inputs })
  .from(runs)
  .innerJoin(inputs, eq(runs.inputId, inputs.id))
  .where(eq(runs.id, source));
if (!src) throw new Error(`run ${source} not found`);
if (src.run.state !== "ended" || src.run.outcome !== "completed") {
  throw new Error(`run ${source} has not completed`);
}
if (src.run.credentials !== "voluma") throw new Error("never seed an example from a visitor run");
if (src.input.source !== "reference") throw new Error("an example reads the reference scan");
if (src.run.example) throw new Error(`run ${source} is itself an example`);

// Replace an earlier seeding of this example, and nothing else.
const [sourceStudy] = await db.select().from(studies).where(eq(studies.id, src.run.studyId));
if (!sourceStudy) throw new Error(`run ${source}'s study ${src.run.studyId} not found`);

const [existing] = await db.select().from(runs).where(eq(runs.id, exampleId));
if (existing && !(existing.example && existing.startedBy === EXAMPLES_OPERATOR)) {
  throw new Error(`run ${exampleId} exists and is not an example; pick another --id`);
}

// A copy keeps every event id, thread id and payload verbatim; only `run_id` changes.
const sourceEvents = await db
  .select()
  .from(events)
  .where(eq(events.runId, source))
  .orderBy(asc(events.seq));
const renamed = sourceEvents.map(({ seq: _seq, ...event }) => ({ ...event, runId: exampleId }));

const copied = await copyPrefix(evidencePrefix);
const copiedReview = await copyPrefix(reviewAssetPrefix, { replace: true });
const copiedSnapshots = await copyPrefix((id) => `${scratchPrefix(id)}person/`, { replace: true });
const copiedOutputs = await copyPrefix(outputsPrefix, { replace: true });
const rows = values.backfill
  ? await withLocalDir(values.backfill, async (dir) =>
      backfillRows(
        exampleId,
        renamed,
        await readBackfill(dir),
        await uploadBackfill(store, exampleId, dir),
      ),
    )
  : renamed;

await db.transaction(async (tx) => {
  await tx.delete(piMessages).where(eq(piMessages.runId, exampleId));
  await tx.delete(events).where(eq(events.runId, exampleId));
  await tx.delete(runs).where(eq(runs.id, exampleId));
  await tx.delete(studyScans).where(eq(studyScans.studyId, studyId));
  await tx.delete(studies).where(eq(studies.id, studyId));

  const reference = referenceInput(demoLabId);
  await tx.insert(inputs).values(reference).onConflictDoNothing();
  await tx.insert(studies).values({
    id: studyId,
    labId: demoLabId,
    name: reference.name,
    workflowId: sourceStudy.workflowId,
    createdBy: EXAMPLES_OPERATOR,
    example: true,
  });
  await tx.insert(studyScans).values({
    studyId,
    inputId: reference.id as string,
    subject: reference.name,
    attributes: {},
    position: 0,
  });
  await tx.insert(runs).values({
    id: exampleId,
    labId: demoLabId,
    startedBy: EXAMPLES_OPERATOR,
    studyId,
    workflows: src.run.workflows,
    selectedOutputs: src.run.selectedOutputs ?? null,
    notes: src.run.notes ?? null,
    inputId: reference.id as string,
    credentials: "voluma",
    example: true,
    state: "ended",
    outcome: "completed",
    startedAt: src.run.startedAt,
    endedAt: src.run.endedAt,
    // Limits skip examples, so no org pays twice.
    modelCostUsd: src.run.modelCostUsd,
    sandboxSeconds: src.run.sandboxSeconds,
  });

  // Postgres caps a statement's parameters, so insert in batches.
  const numbered = rows.map((row, i) => ({ ...row, seq: i + 1 }));
  for (let i = 0; i < numbered.length; i += 500) {
    await tx.insert(events).values(numbered.slice(i, i + 500));
  }
  await tx.execute(sql`
    INSERT INTO pi_messages (run_id, thread_id, idx, message)
    SELECT ${exampleId}, thread_id, idx, message
    FROM pi_messages WHERE run_id = ${source}`);
});

console.log(
  `example run ${exampleId} seeded from ${source} in ${demoLabId}; ${copied} evidence, ${copiedReview} review asset, ${copiedSnapshots} snapshot and ${copiedOutputs} output objects copied`,
);
await client.end();
