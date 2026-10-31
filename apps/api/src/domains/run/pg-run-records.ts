/** Coherent Review reads and serialized human decisions over the Run-owned event log. */
import { randomUUID } from "node:crypto";
import { runEventSchema } from "@voluma/contracts/events";
import { and, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { RunRecords } from "../../ports";
import type { Notifier } from "./notifier";
import { eventLock, insertEvent } from "./pg-event-log";
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
      // which a heartbeat holds the queue lock to wait for.
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
        // Same order as runner append: event lock, then row lock. Lifecycle writes
        // take the row too; none acquires the event lock while holding it.
        await eventLock(tx, runId);
        const [row] = await tx
          .select({ id: runs.id })
          .from(runs)
          .where(and(readableRuns(reader), eq(runs.id, runId)))
          .for("update");
        if (!row) return null;
        const [record] = await results(tx, eq(runs.id, runId));
        if (!record) throw new Error(`run ${runId} vanished inside its transaction`);
        const next = decision(record);
        if (!next) return record;
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
