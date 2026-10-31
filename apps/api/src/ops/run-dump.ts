/**
 * What `run.json` holds, shared by the operator scripts that write it (`export:run`,
 * `archive:run`) and read it (`import:run`): every database row that belongs to one run.
 * Evidence stays in R2 under `runs/<id>/`; nothing there is copied. Shared study, scan,
 * and input rows travel with the run so restoring it never invents research metadata.
 */

import { runEventSchema } from "@voluma/contracts/events";
import { providerCalls } from "@voluma/provider-calls";
import { catalog, workflowById } from "@voluma/workflow/bundled";
import { asc, eq, inArray, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
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

/** Pi messages belong to a run through their thread id (`<runId>.<thread>`). */
export const piMessagesOf = (runId: string) =>
  sql`starts_with(${piMessages.threadId}, ${`${runId}.`})`;

export async function readDump(db: PostgresJsDatabase, runId: string) {
  return db.transaction((tx) => readRows(tx, runId), { isolationLevel: "repeatable read" });
}

async function readRows(db: PostgresJsDatabase, runId: string) {
  const [run] = await db.select().from(runs).where(eq(runs.id, runId));
  if (!run) throw new Error(`run ${runId} not found`);
  const [input] = await db.select().from(inputs).where(eq(inputs.id, run.inputId));
  const [study] = await db.select().from(studies).where(eq(studies.id, run.studyId));
  const scans = await db.select().from(studyScans).where(eq(studyScans.studyId, run.studyId));
  return {
    run,
    input,
    study,
    studyScans: scans,
    studyInputs: await db
      .select()
      .from(inputs)
      .where(inArray(inputs.id, [...new Set([run.inputId, ...scans.map((s) => s.inputId)])])),
    events: await db.select().from(events).where(eq(events.runId, runId)).orderBy(asc(events.seq)),
    threads: await db.select().from(threads).where(eq(threads.runId, runId)),
    piMessages: await db
      .select()
      .from(piMessages)
      .where(piMessagesOf(runId))
      .orderBy(asc(piMessages.threadId), asc(piMessages.idx)),
    reviewSnapshots: await db
      .select()
      .from(reviewSnapshots)
      .where(eq(reviewSnapshots.runId, runId)),
    providerCalls: await db.select().from(providerCalls).where(eq(providerCalls.runId, runId)),
  };
}

/** Row counts of the tables a run owns, for the one-line report and the archive's check. */
export const countsOf = (dump: {
  events: unknown[];
  threads: unknown[];
  piMessages: unknown[];
  reviewSnapshots?: unknown[];
  providerCalls?: unknown[];
}) => ({
  events: dump.events.length,
  threads: dump.threads.length,
  piMessages: dump.piMessages.length,
  reviewSnapshots: dump.reviewSnapshots?.length ?? 0,
  providerCalls: dump.providerCalls?.length ?? 0,
});

export const describeCounts = (c: ReturnType<typeof countsOf>) =>
  `${c.events} events, ${c.threads} threads, ${c.piMessages} pi messages, ${c.reviewSnapshots} snapshots, ${c.providerCalls} gateway requests`;

/**
 * Everything `import:run` needs to hold of a dump, so `archive:run` can refuse to delete a run
 * that `import:run` would refuse to load. Returns the bundled workflow the run belongs to.
 * Throws on a stray row, an event that fails `runEventSchema`, or a workflow not in the catalog.
 */
export function assertRestorable(dump: {
  // `workflowId` is the column dumps carried before studies took it over.
  run: { id: string; workflowId?: string; workflows: unknown };
  study?: { workflowId: string } | null;
  events: { id: string; seq: number; runId: string }[];
  threads: { runId: string }[];
  piMessages: { threadId: string }[];
  // Dumps from before these were exported have neither.
  reviewSnapshots?: { runId: string }[];
  providerCalls?: { runId: string }[];
}) {
  const runId = dump.run.id;
  const workflowId = dump.run.workflowId ?? dump.study?.workflowId;
  const workflowPath = (dump.run.workflows as { path: string }[])[0]?.path;
  const workflow =
    (workflowId ? workflowById(workflowId) : undefined) ??
    Object.values(catalog).find((w) => w.path === workflowPath);
  if (!workflow) {
    throw new Error(
      `run ${runId} used ${workflowId ?? workflowPath}, which is not a bundled workflow`,
    );
  }

  const strays = [
    ...dump.events.filter((e) => e.runId !== runId).map((e) => `event ${e.id}`),
    ...dump.threads.filter((t) => t.runId !== runId).map((t) => `thread of ${t.runId}`),
    ...dump.piMessages.filter((m) => !m.threadId.startsWith(`${runId}.`)).map((m) => m.threadId),
    ...(dump.reviewSnapshots ?? [])
      .filter((s) => s.runId !== runId)
      .map((s) => `snapshot of ${s.runId}`),
    ...(dump.providerCalls ?? []).filter((c) => c.runId !== runId).map((c) => `call of ${c.runId}`),
  ];
  if (strays.length > 0) {
    throw new Error(
      `${strays.length} rows are not run ${runId}'s: ${strays.slice(0, 5).join(", ")}`,
    );
  }

  const failed = dump.events.flatMap((e) => {
    const result = runEventSchema.safeParse(e);
    return result.success ? [] : [`seq ${e.seq} (${e.id}): ${result.error.issues[0]?.message}`];
  });
  if (failed.length > 0) {
    throw new Error(`${failed.length} events fail runEventSchema:\n${failed.join("\n")}`);
  }
  return workflow;
}
