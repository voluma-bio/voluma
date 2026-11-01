/**
 * Postgres adapter for the run's event log, lease-checked. One transaction per append:
 *
 * 1. take a per-run advisory lock, as its own statement. Under READ COMMITTED a
 *    statement's snapshot is taken when it starts, so a lock taken inside the insert's
 *    own statement would not see the previous holder's row and `seq` would collide;
 * 2. check the lease token against the run row (`LeaseLost` rolls the append back);
 * 3. insert with `seq = MAX(seq) + 1`; a repeated event `id` (ids are unique per run) inserts
 *    nothing;
 * 4. if the event was new, move the run's `last_progress_seq` when it is run-state progress
 *    (`claim-progress.ts`).
 *
 * So `seq` is gapless and in commit order per run: a reader that has seen `seq` n has seen
 * every event below it. The stream (stream.ts) relies on that: the notifier fires after a
 * commit, and the stream then reads the log from its cursor, so a missed or early wake-up
 * costs a read, never an event. Stored rows are parsed against the current event schema:
 * the runner's read (`readLeased`) fails on an unsupported historical event rather than
 * reinterpret it; the browser's reads (stream, run loader) skip and log it (`readEvents`). A read
 * that decides a write uses row columns only (cancel, which also runs inside the claim, so it
 * must never refuse) or refuses on an event it can't read (corrections, review).
 */
import type { EventInput, RunEvent } from "@voluma/contracts/events";
import { type CancelRow, cancelEnds } from "@voluma/contracts/threads";
import { and, asc, eq, gt, type SQL, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { ReadScope } from "../../domain";
import { isProgress } from "./claim-progress";
import { assertLease } from "./lease";
import type { Notifier } from "./notifier";
import { openCorrectionOf, readableRuns, readEvents, type Tx, toRunEvent } from "./pg-runs";
import { events, runs } from "./schema";

/** First key of the advisory lock pair; the second is the run. Distinguishes our locks from others'. */
export const EVENT_SEQ_LOCK = 0x76_6f_6c_75;

/** The event lock alone, for a write that appends events without locking the row. */
export const eventLock = (tx: Tx, runId: string) =>
  tx.execute(sql`SELECT pg_advisory_xact_lock(${EVENT_SEQ_LOCK}, hashtext(${runId}))`);

/**
 * The only way the API locks a run row `FOR UPDATE`: the run's event lock, then the row; returns the
 * row, or undefined when none matches `where` (the run, plus any extra condition). Lock order,
 * everywhere: the queue lock (`QUEUE_LOCK`, where a write needs it), then this. A runner's
 * append takes the event lock before it shares the run row (`assertLease`), so a transaction
 * that holds the row and then asks for the event lock can deadlock with it. Exceptions: the
 * gateway's `admitCall` (`packages/provider-calls/src/calls.ts`) locks the row alone and never
 * takes the event lock after it; `FOR SHARE` reads (`assertLease`, `pg-snapshots.ts`) are separate.
 */
export async function lockRun(tx: Tx, runId: string, where?: SQL) {
  await eventLock(tx, runId);
  const [run] = await tx
    .select()
    .from(runs)
    .where(and(eq(runs.id, runId), where))
    .for("update");
  return run;
}

/** Caller holds the event lock and has authorized the write under the run-row lock. */
export async function insertEvent(tx: Tx, event: Omit<RunEvent, "seq">) {
  return tx
    .insert(events)
    .values({
      ...event,
      createdAt: new Date(event.createdAt),
      seq: sql`(SELECT COALESCE(MAX(${events.seq}), 0) + 1 FROM ${events} WHERE ${events.runId} = ${event.runId})`,
    })
    .onConflictDoNothing({ target: [events.runId, events.id] })
    .returning({ id: events.id, seq: events.seq });
}

/**
 * A user's cancel, run inside the queue's transaction before the run row ends: every open
 * thread ends `cancelled` and the root last, ids `<runId>:cancel:end:<threadId>`. Once the row
 * has ended the runner's writes are refused, so this is the only moment the server can leave
 * the log consistent, whether a runner holds the run or none does (a recovered or queued run).
 */
export async function cancelOpenThreads(tx: Tx, runId: string) {
  await eventLock(tx, runId);
  // Row columns, plus the raw payload of the two types `cancelEnds` reads fields of. No json
  // operator touches it: Postgres errors on `\u0000` anywhere in the document, which would
  // fail the claim, sweep or report this cancel runs in. The fields are picked in JS, so an
  // event that no longer parses cannot stop or change a cancel.
  const rows = await tx
    .select({
      id: events.id,
      type: events.type,
      threadId: events.threadId,
      seq: events.seq,
      payload: sql<unknown>`CASE WHEN ${events.type} IN ('thread.started', 'thread.ended') THEN ${events.payload} END`,
    })
    .from(events)
    .where(eq(events.runId, runId))
    .orderBy(asc(events.seq));
  const log = rows.map(({ payload, ...row }): CancelRow => {
    const fields = (payload ?? {}) as { parentThreadId?: unknown; status?: unknown };
    return {
      ...row,
      ...(row.type === "thread.started" && { root: fields.parentThreadId === null }),
      ...(row.type === "thread.ended" &&
        typeof fields.status === "string" && { status: fields.status }),
    };
  });
  for (const ended of cancelEnds(runId, log, new Date(), openCorrectionOf(rows)?.seq)) {
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
     * run has ended, and up to `limit` events with `seq > after`, oldest first (`next` is the
     * last seq read, `full` whether the page filled). One statement,
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
      const stored = rows.flatMap((row) => (row.event ? [row.event] : []));
      // `next` and `full` come from the rows read, not the events kept: a skipped event must
      // not move the cursor back or make a full page look like the end of the log.
      return {
        ended: first.state === "ended",
        events: readEvents(stored).events,
        next: stored.at(-1)?.seq ?? after,
        full: stored.length >= limit,
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

    /** Throws `LeaseLost`. */
    async append(event: EventInput, leaseToken: string) {
      await db.transaction(async (tx) => {
        await eventLock(tx, event.runId);
        await assertLease(tx, event.runId, leaseToken);
        const inserted = await insertEvent(tx, event);
        if (inserted.length === 0) return;
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
