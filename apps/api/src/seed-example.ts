/**
 * Operator script: copy a finished run into an example run in the Demo organization.
 *   pnpm --filter @voluma/api seed:example --from <runId> [--id <exampleRunId>]
 * Reads DATABASE_URL, WORKOS_DEMO_ORGANIZATION_ID and the R2 settings (the repo .env, or the host's variables).
 *
 * The example gets the source's events, threads and history under its own run id (thread
 * ids are `<runId>.…`, so they are renamed), `startedBy: "voluma-examples"`, `example: true`,
 * and the Demo org's reference-scan input. The source's evidence objects in R2 are copied
 * under the example's own prefix (`evidenceKey` builds a key from the run being read, so an
 * example can't point at another run's files). Re-seeding the same `--id` replaces the
 * example, and nothing else: an existing run that isn't an example is refused. The source must be a completed `voluma` run on a reference scan: a visitor run's
 * outputs are untrusted (`@voluma/contracts/run`), and an example's scan is shown to everyone.
 */
import { parseArgs } from "node:util";
import { CopyObjectCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { runIdSchema } from "@voluma/contracts/ids";
import { evidenceKey, runPrefix } from "@voluma/contracts/r2";
import { eq, type SQL, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { EXAMPLES_OPERATOR, referenceInputId } from "./domains/run/pg-run-store";
import { events, inputs, piMessages, runs, threads } from "./domains/run/schema";

const { values } = parseArgs({ options: { from: { type: "string" }, id: { type: "string" } } });
const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
};
if (!values.from) throw new Error("usage: seed:example --from <runId> [--id <exampleRunId>]");
const source = runIdSchema.parse(values.from);
const exampleId = runIdSchema.parse(values.id ?? `example-${source}`);
const demoLabId = required("WORKOS_DEMO_ORGANIZATION_ID");

const client = postgres(required("DATABASE_URL"));
const db = drizzle(client, { casing: "snake_case" });

// Objects are content-addressed and never overwritten, so a repeat copy is harmless.
const bucket = required("R2_BUCKET");
const r2 = new S3Client({
  region: "auto",
  endpoint: `https://${required("R2_ACCOUNT_ID")}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: required("R2_ACCESS_KEY_ID"),
    secretAccessKey: required("R2_SECRET_ACCESS_KEY"),
  },
});
async function copyEvidence(): Promise<number> {
  let copied = 0;
  const evidencePrefix = `${runPrefix(source)}evidence/`;
  for (let token: string | undefined; ; ) {
    const page = await r2.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: evidencePrefix,
        ContinuationToken: token,
      }),
    );
    for (const object of page.Contents ?? []) {
      const sha = (object.Key as string).slice(evidencePrefix.length);
      await r2.send(
        new CopyObjectCommand({
          Bucket: bucket,
          CopySource: `${bucket}/${object.Key}`,
          Key: evidenceKey(exampleId, sha),
        }),
      );
      copied++;
    }
    token = page.NextContinuationToken;
    if (!token) break;
  }
  return copied;
}

let copied = 0;
await db.transaction(async (tx) => {
  const [src] = await tx
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
  const [existing] = await tx.select().from(runs).where(eq(runs.id, exampleId));
  if (existing && !(existing.example && existing.startedBy === EXAMPLES_OPERATOR)) {
    throw new Error(`run ${exampleId} exists and is not an example; pick another --id`);
  }

  copied = await copyEvidence(); // after every check, so a refused seed copies nothing
  await tx.delete(piMessages).where(sql`starts_with(${piMessages.threadId}, ${`${exampleId}.`})`);
  await tx.delete(threads).where(eq(threads.runId, exampleId));
  await tx.delete(events).where(eq(events.runId, exampleId));
  await tx.delete(runs).where(eq(runs.id, exampleId));

  await tx
    .insert(inputs)
    .values({
      id: referenceInputId(demoLabId),
      labId: demoLabId,
      source: "reference",
      uploadedBy: EXAMPLES_OPERATOR,
      name: src.input.name,
    })
    .onConflictDoNothing();
  await tx.insert(runs).values({
    id: exampleId,
    labId: demoLabId,
    startedBy: EXAMPLES_OPERATOR,
    workflowId: src.run.workflowId,
    workflows: src.run.workflows,
    inputId: referenceInputId(demoLabId),
    credentials: "voluma",
    example: true,
    state: "ended",
    outcome: "completed",
    startedAt: src.run.startedAt,
    endedAt: src.run.endedAt,
  });

  // Thread ids begin `<runId>.`; in the payloads they are the only strings that do.
  const rename = (text: SQL) => sql`${exampleId} || substr(${text}, ${source.length + 1})`;
  const renamePayload = sql`replace(payload::text, ${`"${source}.`}, ${`"${exampleId}.`})::json`;
  await tx.execute(sql`
    INSERT INTO events (id, run_id, thread_id, seq, type, payload, created_at)
    SELECT ${exampleId} || ':' || id, ${exampleId}, ${rename(sql`thread_id`)}, seq, type, ${renamePayload}, created_at
    FROM events WHERE run_id = ${source}`);
  await tx.execute(sql`
    INSERT INTO threads (id, run_id, parent_thread_id, kind, task, status, created_at, ended_at)
    SELECT ${rename(sql`id`)}, ${exampleId},
      CASE WHEN parent_thread_id IS NULL THEN NULL ELSE ${rename(sql`parent_thread_id`)} END,
      kind, task, status, created_at, ended_at
    FROM threads WHERE run_id = ${source}`);
  await tx.execute(sql`
    INSERT INTO pi_messages (thread_id, idx, message)
    SELECT ${rename(sql`thread_id`)}, idx, message
    FROM pi_messages WHERE starts_with(thread_id, ${`${source}.`})`);
});

console.log(
  `example run ${exampleId} seeded from ${source} in ${demoLabId}; ${copied} evidence objects copied`,
);
await client.end();
