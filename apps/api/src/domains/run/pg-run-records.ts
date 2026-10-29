/** Coherent Review reads and serialized human decisions over the Run-owned event log. */
import { randomUUID } from "node:crypto";
import { runEventSchema } from "@voluma/contracts/events";
import { and, eq, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { RunRecords } from "../../ports";
import type { Notifier } from "./notifier";
import { EVENT_SEQ_LOCK, insertEvent } from "./pg-event-log";
import { loadRecords, readableRuns } from "./pg-runs";
import { runs } from "./schema";

export function pgRunRecords(db: PostgresJsDatabase, notifier: Notifier): RunRecords {
  return {
    load: (reader, runId) =>
      db.transaction(
        async (tx) =>
          (await loadRecords(tx, and(readableRuns(reader), eq(runs.id, runId)), true))[0] ?? null,
        { isolationLevel: "repeatable read" },
      ),
    readable: async (reader, runId) => {
      const rows = await db
        .select({ id: runs.id })
        .from(runs)
        .where(and(readableRuns(reader), eq(runs.id, runId)));
      return rows.length > 0;
    },
    async decide(reader, runId, decision) {
      const result = await db.transaction(async (tx) => {
        // Same order as runner append: event lock, then row lock. Lifecycle writes
        // take the row too; none acquires the event lock while holding it.
        await tx.execute(sql`SELECT pg_advisory_xact_lock(${EVENT_SEQ_LOCK}, hashtext(${runId}))`);
        const [row] = await tx
          .select({ id: runs.id })
          .from(runs)
          .where(and(readableRuns(reader), eq(runs.id, runId)))
          .for("update");
        if (!row) return null;
        const [record] = await loadRecords(tx, eq(runs.id, runId), true);
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
        return (await loadRecords(tx, eq(runs.id, runId), true))[0] ?? null;
      });
      if (result) notifier.notify(runId);
      return result;
    },
  };
}
