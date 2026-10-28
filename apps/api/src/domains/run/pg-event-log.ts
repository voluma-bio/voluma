/**
 * Postgres adapter for the run's event log, lease-checked. One transaction per append:
 *
 * 1. take a per-run advisory lock, as its own statement. Under READ COMMITTED a
 *    statement's snapshot is taken when it starts, so a lock taken inside the insert's
 *    own statement would not see the previous holder's row and `seq` would collide;
 * 2. check the lease token against the run row (`LeaseLost` rolls the append back);
 * 3. insert with `seq = MAX(seq) + 1`; a repeated event `id` inserts nothing, and is
 *    `EventIdTaken` if the stored event belongs to another run;
 * 4. apply the `threads` projection, only if the event was new.
 *
 * So `seq` is gapless and in commit order per run. The stream hub relies on that:
 * publish after commit, and a gap means backfill from the log.
 */
import type { EventInput } from "@voluma/contracts/events";
import { and, eq, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { assertLease } from "./lease";
import type { Tx } from "./pg-runs";
import { events, threads } from "./schema";

/** An event id already stored under another run. */
export class EventIdTaken extends Error {
  constructor() {
    super("event id belongs to another run");
  }
}

/** First key of the advisory lock pair; the second is the run. Distinguishes our locks from others'. */
const EVENT_SEQ_LOCK = 0x76_6f_6c_75;

export function pgEventLog(db: PostgresJsDatabase) {
  return {
    /** Throws `LeaseLost`, or `EventIdTaken` for an id stored under another run. */
    async append(event: EventInput, leaseToken: string) {
      await db.transaction(async (tx) => {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(${EVENT_SEQ_LOCK}, hashtext(${event.runId}))`,
        );
        await assertLease(tx, event.runId, leaseToken);
        const createdAt = new Date(event.createdAt);
        const inserted = await tx
          .insert(events)
          .values({
            id: event.id,
            runId: event.runId,
            threadId: event.threadId,
            seq: sql`(SELECT COALESCE(MAX(${events.seq}), 0) + 1 FROM ${events} WHERE ${events.runId} = ${event.runId})`,
            type: event.type,
            payload: event.payload,
            createdAt,
          })
          .onConflictDoNothing({ target: events.id })
          .returning({ id: events.id });
        if (inserted.length === 0) {
          const [stored] = await tx
            .select({ runId: events.runId })
            .from(events)
            .where(eq(events.id, event.id));
          if (stored?.runId !== event.runId) throw new EventIdTaken();
          return;
        }
        await projectThread(tx, event, createdAt);
      });
    },
  };
}

async function projectThread(tx: Tx, event: EventInput, createdAt: Date) {
  switch (event.type) {
    case "thread.started":
      // A resumed thread starts again: same row, running again.
      await tx
        .insert(threads)
        .values({
          id: event.threadId,
          runId: event.runId,
          parentThreadId: event.payload.parentThreadId,
          kind: event.payload.kind,
          task: event.payload.task ?? null,
          status: "running",
          createdAt,
        })
        .onConflictDoUpdate({
          target: threads.id,
          set: { status: "running", endedAt: null },
          setWhere: eq(threads.runId, event.runId),
        });
      return;
    case "thread.ended":
      await tx
        .update(threads)
        .set({ status: event.payload.status, endedAt: createdAt })
        .where(and(eq(threads.id, event.threadId), eq(threads.runId, event.runId)));
      return;
  }
}

export type LeasedEventLog = ReturnType<typeof pgEventLog>;
