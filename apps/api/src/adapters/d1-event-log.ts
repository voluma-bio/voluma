/**
 * D1 adapter for the EventLog port. `seq` is allocated inside the insert, so
 * concurrent appends can't collide; a repeated event `id` inserts nothing. The
 * `threads` projection changes in the same batch as its `thread.*` event.
 */
import type { EventInput } from "@voluma/contracts/events";
import type { EventLog } from "@voluma/harness/ports/event-log";

export function d1EventLog(db: D1Database): EventLog {
  return {
    async append(event) {
      await db.batch([
        db
          .prepare(
            `INSERT OR IGNORE INTO events (id, run_id, thread_id, seq, type, payload, created_at)
             SELECT ?1, ?2, ?3, COALESCE(MAX(seq), 0) + 1, ?4, ?5, ?6 FROM events WHERE run_id = ?2`,
          )
          .bind(
            event.id,
            event.runId,
            event.threadId,
            event.type,
            JSON.stringify(event.payload),
            event.createdAt,
          ),
        ...threadProjection(db, event),
      ]);
    },
  };
}

function threadProjection(db: D1Database, event: EventInput): D1PreparedStatement[] {
  switch (event.type) {
    case "thread.started":
      // A resumed thread starts again: same row, running again.
      return [
        db
          .prepare(
            `INSERT INTO threads (id, run_id, parent_thread_id, kind, task, status, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, 'running', ?6)
             ON CONFLICT (id) DO UPDATE SET status = 'running', ended_at = NULL`,
          )
          .bind(
            event.threadId,
            event.runId,
            event.payload.parentThreadId,
            event.payload.kind,
            event.payload.task ?? null,
            event.createdAt,
          ),
      ];
    case "thread.ended":
      return [
        db
          .prepare("UPDATE threads SET status = ?2, ended_at = ?3 WHERE id = ?1")
          .bind(event.threadId, event.payload.status, event.createdAt),
      ];
    default:
      return [];
  }
}
