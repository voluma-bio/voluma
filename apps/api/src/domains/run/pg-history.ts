/**
 * Postgres adapter for the run's model history: `pi_messages`, one row
 * per message. Each call checks the lease token in its transaction. An
 * append only lands on the next free idx; repeating a stored idx with the same text
 * is a no-op, so the client may retry (a racing retry hits the primary key and does
 * nothing, then compares).
 */
import { HistoryConflict } from "@voluma/harness/ports/history";
import { and, asc, eq, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { assertLease } from "./lease";
import { piMessages } from "./schema";

export function pgHistory(db: PostgresJsDatabase) {
  return {
    load: (runId: string, threadId: string, leaseToken: string) =>
      db.transaction(async (tx) => {
        await assertLease(tx, runId, leaseToken);
        const rows = await tx
          .select({ message: piMessages.message })
          .from(piMessages)
          .where(and(eq(piMessages.runId, runId), eq(piMessages.threadId, threadId)))
          .orderBy(asc(piMessages.idx));
        return rows.map((row) => row.message);
      }),
    appendMessage: (
      runId: string,
      threadId: string,
      idx: number,
      message: string,
      leaseToken: string,
    ) =>
      db.transaction(async (tx) => {
        await assertLease(tx, runId, leaseToken);
        const inserted = await tx.execute(sql`
          INSERT INTO pi_messages (run_id, thread_id, idx, message)
          SELECT ${runId}, ${threadId}, ${idx}::integer, ${message}
          WHERE ${idx}::integer = 0
             OR EXISTS (SELECT 1 FROM pi_messages WHERE run_id = ${runId} AND thread_id = ${threadId} AND idx = ${idx}::integer - 1)
          ON CONFLICT (run_id, thread_id, idx) DO NOTHING
          RETURNING idx`);
        if (inserted.length > 0) return;
        const [existing] = await tx
          .select({ message: piMessages.message })
          .from(piMessages)
          .where(
            and(
              eq(piMessages.runId, runId),
              eq(piMessages.threadId, threadId),
              eq(piMessages.idx, idx),
            ),
          );
        if (existing?.message !== message) {
          throw new HistoryConflict(`thread ${threadId}: idx ${idx} is not the next free row`);
        }
      }),
  };
}

export type LeasedHistory = ReturnType<typeof pgHistory>;
