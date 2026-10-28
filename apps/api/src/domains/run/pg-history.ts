/**
 * Postgres adapter for the History port: `pi_messages`, one row per message. An
 * append only lands on the next free idx; repeating a stored idx with the same text
 * is a no-op, so the client may retry (a racing retry hits the primary key and does
 * nothing, then compares).
 */
import { type History, HistoryConflict } from "@voluma/harness/ports/history";
import { and, asc, eq, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { piMessages } from "./schema";

export function pgHistory(db: PostgresJsDatabase): History {
  return {
    async load(threadId) {
      const rows = await db
        .select({ message: piMessages.message })
        .from(piMessages)
        .where(eq(piMessages.threadId, threadId))
        .orderBy(asc(piMessages.idx));
      return rows.map((row) => row.message);
    },
    async appendMessage(threadId, idx, message) {
      const inserted = await db.execute(sql`
        INSERT INTO pi_messages (thread_id, idx, message)
        SELECT ${threadId}, ${idx}::integer, ${message}
        WHERE ${idx}::integer = 0
           OR EXISTS (SELECT 1 FROM pi_messages WHERE thread_id = ${threadId} AND idx = ${idx}::integer - 1)
        ON CONFLICT (thread_id, idx) DO NOTHING
        RETURNING idx`);
      if (inserted.length > 0) return;
      const [existing] = await db
        .select({ message: piMessages.message })
        .from(piMessages)
        .where(and(eq(piMessages.threadId, threadId), eq(piMessages.idx, idx)));
      if (existing?.message !== message) {
        throw new HistoryConflict(`thread ${threadId}: idx ${idx} is not the next free row`);
      }
    },
  };
}
