/**
 * Postgres adapter for the run's event log, lease-checked. One transaction per append:
 *
 * 1. take a per-run advisory lock, as its own statement. Under READ COMMITTED a
 *    statement's snapshot is taken when it starts, so a lock taken inside the insert's
 *    own statement would not see the previous holder's row and `seq` would collide;
 * 2. check the lease token against the run row (`LeaseLost` rolls the append back);
 * 3. insert with `seq = MAX(seq) + 1`; a repeated event `id` inserts nothing, and is
 *    `EventIdTaken` if the stored event belongs to another run;
 * 4. if the event was new, move the run's `last_progress_seq` when it is run-state progress
 *    (`claim-progress.ts`).
 *
 * So `seq` is gapless and in commit order per run: a reader that has seen `seq` n has seen
 * every event below it. The stream (stream.ts) relies on that: the notifier fires after a
 * commit, and the stream then reads the log from its cursor, so a missed or early wake-up
 * costs a read, never an event. Stored rows are parsed against the current event schema:
 * an unsupported historical event fails the read rather than being reinterpreted.
 */
import type { EventInput, RunEvent } from "@voluma/contracts/events";
import { cancelEnds } from "@voluma/contracts/threads";
import { and, asc, eq, gt, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { ReadScope } from "../../domain";
import { isProgress } from "./claim-progress";
import { assertLease } from "./lease";
import type { Notifier } from "./notifier";
import { readableRuns, type Tx, toRunEvent } from "./pg-runs";
import { events, runs } from "./schema";

/** An event id already stored under another run. */
export class EventIdTaken extends Error {
  constructor() {
    super("event id belongs to another run");
  }
}

/** First key of the advisory lock pair; the second is the run. Distinguishes our locks from others'. */
export const EVENT_SEQ_LOCK = 0x76_6f_6c_75;

/**
 * The run's event lock. Lock order, everywhere: the queue lock, then this, then row locks
 * (`corrections.ts`).
 */
export const eventLock = (tx: Tx, runId: string) =>
  tx.execute(sql`SELECT pg_advisory_xact_lock(${EVENT_SEQ_LOCK}, hashtext(${runId}))`);

/** Caller holds the event lock and has authorized the write under the run-row lock. */
export async function insertEvent(tx: Tx, event: Omit<RunEvent, "seq">) {
  return (
    tx
      .insert(events)
      .values({
        ...event,
        createdAt: new Date(event.createdAt),
        seq: sql`(SELECT COALESCE(MAX(${events.seq}), 0) + 1 FROM ${events} WHERE ${events.runId} = ${event.runId})`,
      })
      // No target: the previous key `(id)` and the run-keyed one `(run_id, id)` both skip a repeat, so
      // this works before and after the contract migration.
      .onConflictDoNothing()
      .returning({ id: events.id, seq: events.seq })
  );
}

/**
 * A user's cancel, run inside the queue's transaction before the run row ends: every open
 * thread ends `cancelled` and the root last, ids `<runId>:cancel:end:<threadId>`. Once the row
 * has ended the runner's writes are refused, so this is the only moment the server can leave
 * the log consistent, whether a runner holds the run or none does (a recovered or queued run).
 */
export async function cancelOpenThreads(tx: Tx, runId: string) {
  await eventLock(tx, runId);
  const log = (
    await tx.select().from(events).where(eq(events.runId, runId)).orderBy(asc(events.seq))
  ).map(toRunEvent);
  for (const ended of cancelEnds(runId, log, new Date())) {
    await insertEvent(tx, ended);
  }
}

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
    async stream(reader: ReadScope, runId: string, after: number, limit: number) {
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

    /** Throws `LeaseLost` unless the token holds the running run's lease. */
    checkLease: (runId: string, leaseToken: string) =>
      db.transaction((tx) => assertLease(tx, runId, leaseToken)),

    /** Throws `LeaseLost`, or `EventIdTaken` for an id stored under another run. */
    async append(event: EventInput, leaseToken: string) {
      await db.transaction(async (tx) => {
        await eventLock(tx, event.runId);
        await assertLease(tx, event.runId, leaseToken);
        const inserted = await insertEvent(tx, event);
        if (inserted.length === 0) {
          const [stored] = await tx
            .select({ id: events.id })
            .from(events)
            .where(and(eq(events.runId, event.runId), eq(events.id, event.id)));
          if (!stored) throw new EventIdTaken();
          return;
        }
        const [row] = inserted;
        if (row && isProgress(event)) {
          await tx.update(runs).set({ lastProgressSeq: row.seq }).where(eq(runs.id, event.runId));
        }
      });
      notifier.notify(event.runId);
    },
  };
}

export type LeasedEventLog = ReturnType<typeof pgEventLog>;
