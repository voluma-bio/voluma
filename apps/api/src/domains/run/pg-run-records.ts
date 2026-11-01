/** Coherent Review reads and serialized human decisions over the Run-owned event log. */
import { randomUUID } from "node:crypto";
import { runEventSchema } from "@voluma/contracts/events";
import { and, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { HTTPException } from "hono/http-exception";
import type { RunRecords } from "../../ports";
import type { Notifier } from "./notifier";
import { insertEvent, lockRun } from "./pg-event-log";
import { type ResultsLoader, readableRuns } from "./pg-runs";
import { runs } from "./schema";

export function pgRunRecords(
  db: PostgresJsDatabase,
  notifier: Notifier,
  results: ResultsLoader,
): RunRecords {
  return {
    load: (reader, runId) =>
      db.transaction(
        async (tx) => (await results(tx, and(readableRuns(reader), eq(runs.id, runId))))[0] ?? null,
        { isolationLevel: "repeatable read" },
      ),
    readable: async (reader, runId) => {
      const [row] = await db
        .select({ generation: runs.generation })
        .from(runs)
        .where(and(readableRuns(reader), eq(runs.id, runId)));
      return row ?? null;
    },
    async decide(reader, runId, decision) {
      // A run that has not ended has no review to decide on: judge it without the event lock,
      // which a heartbeat or report holds while it ends a run.
      const [state] = await db
        .select({ state: runs.state })
        .from(runs)
        .where(and(readableRuns(reader), eq(runs.id, runId)));
      if (!state) return null;
      if (state.state !== "ended") {
        const record = await db.transaction(
          async (tx) => (await results(tx, eq(runs.id, runId)))[0],
          { isolationLevel: "repeatable read" },
        );
        if (!record) return null;
        if (!decision(record)) return record;
      }
      const result = await db.transaction(async (tx) => {
        const row = await lockRun(tx, runId, readableRuns(reader));
        if (!row) return null;
        const [record] = await results(tx, eq(runs.id, runId));
        if (!record) throw new Error(`run ${runId} vanished inside its transaction`);
        const next = decision(record);
        if (!next) return record;
        // A decision is stored against what the page showed, and a skipped fold event left some of it out.
        if (record.skipped)
          throw new HTTPException(409, {
            message: "This run has an event that can't be read, so it can't be reviewed.",
          });
        await insertEvent(
          tx,
          runEventSchema.parse({
            ...next,
            id: randomUUID(),
            runId,
            threadId: `${runId}.reviewer`,
            seq: 0,
            createdAt: new Date().toISOString(),
          }),
        );
        // The write moved the run's watermark, so this read takes only the fold's events.
        return (await results(tx, eq(runs.id, runId)))[0] ?? null;
      });
      if (result) notifier.notify(runId);
      return result;
    },
  };
}
