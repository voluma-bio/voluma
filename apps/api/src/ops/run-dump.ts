/**
 * What `run.json` holds, shared by the operator scripts that write it (`export:run`,
 * `archive:run`) and read it (`import:run`): every database row that belongs to one run.
 * Evidence stays in R2 under `runs/<id>/`; nothing there is copied. The run's input is
 * shared with other runs and the study is rebuilt on import, so both are kept for the
 * record and for `archive:run` to check, not to be inserted as they are.
 */

import { providerCalls } from "@voluma/provider-calls";
import { asc, eq, sql } from "drizzle-orm";
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
  const [run] = await db.select().from(runs).where(eq(runs.id, runId));
  if (!run) throw new Error(`run ${runId} not found`);
  const [input] = await db.select().from(inputs).where(eq(inputs.id, run.inputId));
  const [study] = await db.select().from(studies).where(eq(studies.id, run.studyId));
  return {
    run,
    input,
    study,
    studyScans: await db.select().from(studyScans).where(eq(studyScans.studyId, run.studyId)),
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
  `${c.events} events, ${c.threads} threads, ${c.piMessages} pi messages, ${c.reviewSnapshots} snapshots, ${c.providerCalls} provider calls`;
