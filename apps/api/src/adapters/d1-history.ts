/**
 * D1 adapter for the History port: `pi_messages`, one row per message. An append
 * only lands on the next free idx; repeating a stored idx with the same text is a
 * no-op, so the client may retry.
 */
import { type History, HistoryConflict } from "@voluma/harness/ports/history";

export function d1History(db: D1Database): History {
  return {
    async load(threadId) {
      const { results } = await db
        .prepare("SELECT message FROM pi_messages WHERE thread_id = ? ORDER BY idx")
        .bind(threadId)
        .all<{ message: string }>();
      return results.map((row) => row.message);
    },
    async appendMessage(threadId, idx, message) {
      const inserted = await db
        .prepare(
          `INSERT INTO pi_messages (thread_id, idx, message)
           SELECT ?1, ?2, ?3 WHERE ?2 = (SELECT COUNT(*) FROM pi_messages WHERE thread_id = ?1)`,
        )
        .bind(threadId, idx, message)
        .run();
      if (inserted.meta.changes > 0) return;
      const existing = await db
        .prepare("SELECT message FROM pi_messages WHERE thread_id = ? AND idx = ?")
        .bind(threadId, idx)
        .first<{ message: string }>();
      if (existing?.message !== message) {
        throw new HistoryConflict(`thread ${threadId}: idx ${idx} is not the next free row`);
      }
    },
  };
}
