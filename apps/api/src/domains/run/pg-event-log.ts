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
 * So `seq` is gapless and in commit order per run: a reader that has seen `seq` n has seen
 * every event below it. The stream (stream.ts) relies on that: the notifier fires after a
 * commit, and the stream then reads the log from its cursor, so a missed or early wake-up
 * costs a read, never an event.
 */
import type { EventInput, RunEvent } from "@voluma/contracts/events";
import { and, asc, eq, gt, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { Reader } from "../../domain";
import { assertLease } from "./lease";
import type { Notifier } from "./notifier";
import { readableRuns, type Tx } from "./pg-runs";
import { events, runs, threads } from "./schema";

/** An event id already stored under another run. */
export class EventIdTaken extends Error {
  constructor() {
    super("event id belongs to another run");
  }
}

/** First key of the advisory lock pair; the second is the run. Distinguishes our locks from others'. */
const EVENT_SEQ_LOCK = 0x76_6f_6c_75;

const toRunEvent = (row: typeof events.$inferSelect) =>
  ({ ...row, createdAt: row.createdAt.toISOString() }) as RunEvent;

export function pgEventLog(db: PostgresJsDatabase, notifier: Notifier) {
  const readAfter = async (runId: string, after: number, limit: number, tx: Tx | typeof db) =>
    (
      await tx
        .select()
        .from(events)
        .where(and(eq(events.runId, runId), gt(events.seq, after)))
        .orderBy(asc(events.seq))
        .limit(limit)
    ).map(toRunEvent);

  return {
    /**
     * The browser's read, scoped to what `reader` can read (null when it can't): whether the
     * run has ended, and up to `limit` events with `seq > after`, oldest first. One statement,
     * so one snapshot: an append holds `FOR SHARE` on the run row until it commits and every
     * end is an `UPDATE` of that row, so a snapshot that shows `ended` shows every event.
     */
    async stream(reader: Reader, runId: string, after: number, limit: number) {
      const page = db
        .select()
        .from(events)
        .where(and(eq(events.runId, runs.id), gt(events.seq, after)))
        .orderBy(asc(events.seq))
        .limit(limit)
        .as("page");
      const rows = await db
        .select({
          state: runs.state,
          event: {
            id: page.id,
            runId: page.runId,
            threadId: page.threadId,
            seq: page.seq,
            type: page.type,
            payload: page.payload,
            createdAt: page.createdAt,
          },
        })
        .from(runs)
        .leftJoinLateral(page, sql`true`)
        .where(and(readableRuns(reader), eq(runs.id, runId)))
        .orderBy(asc(page.seq));
      const first = rows[0];
      if (!first) return null;
      return {
        ended: first.state === "ended",
        events: rows.flatMap((row) => (row.event ? [toRunEvent(row.event)] : [])),
      };
    },

    /** The runner's read: events after a seq, but the lease is checked in the same transaction. */
    readLeased: (runId: string, leaseToken: string, after: number, limit: number) =>
      db.transaction(async (tx) => {
        await assertLease(tx, runId, leaseToken);
        return readAfter(runId, after, limit, tx);
      }),

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
      notifier.notify(event.runId);
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
