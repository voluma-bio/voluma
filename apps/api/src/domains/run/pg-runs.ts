/**
 * Postgres adapter for the browser's reads of runs and inputs, and the row shapes the
 * queue shares. Reads apply the caller's `Reader` (domain.ts) once, so another org's run
 * is just absent. Every state change is in pg-queue.ts.
 */

import { type RunEvent, runEventSchema } from "@voluma/contracts/events";
import { FOLD_EVENT_TYPES } from "@voluma/contracts/fold";
import { openCorrectionRevision, progress, reviewState } from "@voluma/contracts/review-state";
import { type Input, type Run, runSchema } from "@voluma/contracts/run";
import { failedThreads, openThreads } from "@voluma/contracts/threads";
import type { WorkflowPin } from "@voluma/contracts/workflow";
import { callsOfRuns, type RunCalls } from "@voluma/provider-calls";
import { and, asc, desc, eq, inArray, or, type SQL, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { EVERY_LAB, type Reader, type ReadScope } from "../../domain";
import { events, inputs, referenceInput, runs, studies } from "./schema";

export type Tx = Parameters<Parameters<PostgresJsDatabase["transaction"]>[0]>[0];

/** `lab_id = labId AND (ownerId IS NULL OR started_by = ownerId OR example)`; every run for `EVERY_LAB`. */
export const readableRuns = (scope: ReadScope): SQL | undefined =>
  scope === EVERY_LAB
    ? undefined
    : and(
        eq(runs.labId, scope.labId),
        scope.ownerId === null
          ? undefined
          : or(eq(runs.startedBy, scope.ownerId), eq(runs.example, true)),
      );

/** The same rule on a study: `lab_id = labId AND (ownerId IS NULL OR created_by = ownerId OR example)`. */
export const readableStudies = (scope: ReadScope): SQL | undefined =>
  scope === EVERY_LAB
    ? undefined
    : and(
        eq(studies.labId, scope.labId),
        scope.ownerId === null
          ? undefined
          : or(eq(studies.createdBy, scope.ownerId), eq(studies.example, true)),
      );

/** The input rule: the caller's upload, or the org's reference scan. */
export const readableInputs = ({ labId, ownerId }: Reader): SQL | undefined =>
  and(
    eq(inputs.labId, labId),
    ownerId === null
      ? undefined
      : or(eq(inputs.uploadedBy, ownerId), eq(inputs.source, "reference")),
  );

type Row = {
  run: typeof runs.$inferSelect;
  input: typeof inputs.$inferSelect;
  position: number | null;
  /** The run's gateway calls that are no longer in flight. */
  calls: RunCalls;
};

export const toInput = (row: typeof inputs.$inferSelect): Input => ({
  id: row.id,
  labId: row.labId,
  source: row.source,
  uploadedBy: row.uploadedBy,
  name: row.name,
});

export const toRunEvent = (row: typeof events.$inferSelect) =>
  runEventSchema.parse({ ...row, createdAt: row.createdAt.toISOString() });

function toRun({ run, input, position, calls }: Row, { summary, revisions }: Results): Run {
  const iso = (d: Date | null) => d?.toISOString() ?? null;
  const startedAt = iso(run.startedAt);
  const state = ((): Run["state"] => {
    switch (run.state) {
      case "queued":
        return { status: "queued", position: position ?? 1 };
      case "running":
        return { status: "running", startedAt: startedAt as string };
      case "awaiting-keys":
        return { status: "awaiting-keys", startedAt };
      case "ended":
        return {
          status: "ended",
          outcome: run.outcome as "completed" | "failed" | "cancelled",
          startedAt,
          endedAt: iso(run.endedAt) as string,
          ...(run.error === null ? {} : { error: run.error }),
        };
    }
  })();
  return runSchema.parse({
    id: run.id,
    labId: run.labId,
    startedBy: run.startedBy,
    studyId: run.studyId,
    workflows: run.workflows as WorkflowPin[],
    ...(run.selectedOutputs !== null && { selectedOutputs: run.selectedOutputs as string[] }),
    ...(run.notes !== null && { notes: run.notes }),
    input: toInput(input),
    credentials: run.credentials,
    example: run.example,
    createdAt: run.createdAt.toISOString(),
    state,
    usage: { modelCostUsd: run.modelCostUsd, sandboxSeconds: run.sandboxSeconds },
    providerCalls: calls,
    review: run.state === "ended" && run.outcome === "completed" ? summary : null,
    tasks: run.state === "ended" ? null : progressOf(revisions.at(-1)),
  });
}

/**
 * Runs matching `where`, newest first. A queued `voluma` run's place is counted here, at
 * read time: its place among its org's queued `voluma` runs, oldest first. A visitor run
 * waits only for a runner, so its place is 1.
 */
async function loadRows(tx: Tx, where: SQL | undefined): Promise<Row[]> {
  const place = tx.$with("place").as(
    tx
      .select({
        id: runs.id,
        position:
          sql<number>`(row_number() OVER (PARTITION BY ${runs.labId} ORDER BY ${runs.createdAt}, ${runs.id}))::int`.as(
            "position",
          ),
      })
      .from(runs)
      .where(and(eq(runs.state, "queued"), eq(runs.credentials, "voluma"))),
  );
  const rows = await tx
    .with(place)
    .select({
      run: runs,
      input: inputs,
      position: place.position,
    })
    .from(runs)
    .innerJoin(inputs, eq(runs.inputId, inputs.id))
    .leftJoin(place, eq(place.id, runs.id))
    .where(where)
    .orderBy(desc(runs.createdAt), desc(runs.id));
  const calls = await callsOfRuns(
    tx,
    rows.map(({ run }) => run.id),
  );
  return rows.map((row) => ({
    ...row,
    calls: calls.get(row.run.id) ?? { costUsd: 0, calls: 0, unknownCostCalls: 0, bySandbox: [] },
  }));
}

/**
 * The fold's events of each run, in `seq` order. Rows an older build wrote cross a trust
 * boundary: a run whose events no longer parse is reported in `unreadable` instead of
 * throwing, so `loadResults` decides what that means for its caller.
 */
async function loadLogs(tx: Tx, ids: string[]) {
  const logs = new Map<string, RunEvent[]>();
  const unreadable = new Set<string>();
  if (ids.length) {
    const stored = await tx
      .select()
      .from(events)
      .where(and(inArray(events.runId, ids), inArray(events.type, [...FOLD_EVENT_TYPES])))
      .orderBy(asc(events.seq));
    for (const row of stored) {
      if (unreadable.has(row.runId)) continue;
      try {
        const log = logs.get(row.runId) ?? [];
        log.push(toRunEvent(row));
        logs.set(row.runId, log);
      } catch (error) {
        unreadable.add(row.runId);
        logs.delete(row.runId);
        console.error(`run ${row.runId}: event ${row.id} (${row.type}) does not parse:`, error);
      }
    }
  }
  return { logs, unreadable };
}

type Results = ReturnType<typeof reviewState>;
type Revision = Results["revisions"][number];

/**
 * What the cache keeps of one run: its `reviewState` (the whole `results` for Review; the run's
 * summary and progress, and a study's values and open checks, are read from it), and what
 * `taskStates` needs that only the log knows.
 */
export type RunFold = {
  results: Results;
  /** An open correction's revision, which task states read; none when no correction is open. */
  correcting: Revision | undefined;
  /** The threads started and not yet ended (`openThreads`). */
  open: readonly string[];
  /** The threads whose latest end failed (`failedThreads`). */
  failed: ReadonlySet<string>;
};

const foldRun = (log: RunEvent[]): RunFold => ({
  results: reviewState(log),
  correcting: openCorrectionRevision(log),
  open: openThreads(log),
  failed: failedThreads(log),
});

const NOTHING = foldRun([]);

/** A revision's finished tasks out of its plan's; null before there is a revision. */
function progressOf(latest: Revision | undefined): Run["tasks"] {
  if (!latest) return null;
  const { done, total } = progress(latest);
  return { done, total };
}

/**
 * One run's cache entry: null `fold` is the verdict that its events don't parse, kept against
 * the watermark so an unreadable run isn't loaded again on every read. `weight` is its event
 * count, a stand-in for its size.
 */
type CacheEntry = { lastEventId: string | null; fold: RunFold | null; weight: number };
type SummaryCache = { entries: Map<string, CacheEntry>; weight: number };

/**
 * The most event-weight kept (~76 bytes of results per folded event, so about 20 MB of JSON), least
 * recently read out first; evicted ones are folded again from the event log.
 */
const CACHE_BUDGET = 250_000;

function newCache(): SummaryCache {
  return { entries: new Map(), weight: 0 };
}

function remember(cache: SummaryCache, id: string, entry: CacheEntry) {
  cache.weight -= cache.entries.get(id)?.weight ?? 0;
  // Delete first, so the entry goes last in the map's insertion order.
  cache.entries.delete(id);
  cache.entries.set(id, entry);
  cache.weight += entry.weight;
  for (const [oldest, { weight }] of cache.entries) {
    if (cache.weight <= CACHE_BUDGET || oldest === id) break;
    cache.entries.delete(oldest);
    cache.weight -= weight;
  }
}

export type RunResult = { run: Run; generation: string } & RunFold;

interface LoadOptions {
  cache?: SummaryCache;
  /**
   * The lists and the study reads: a completed run whose events no longer parse is left out
   * rather than failing every run listed with it. Without it (one run's read) it throws: the
   * run's own page must fail loudly, not read as "no plan" (a 409 the web polls forever).
   * A completed run with no revision is left out the same way. Any other run whose events
   * don't parse is kept, with `tasks: null`: it still runs.
   */
  skipUnreadable?: boolean;
  /**
   * Which failed or cancelled runs to fold. A stopped run's row says all a list shows of it
   * (`review` and `tasks` are null), so the lists take `none`; the study read takes `newest`, a
   * scan's newest run, to show where it stopped; one run's read (default) takes `all`. A run
   * left out reads as having no events.
   */
  stopped?: "all" | "newest" | "none";
}

async function loadResults(
  tx: Tx,
  where: SQL | undefined,
  { cache = newCache(), skipUnreadable = false, stopped = "all" }: LoadOptions = {},
): Promise<RunResult[]> {
  const rows = await loadRows(tx, where);
  // Rows are newest first, so a scan's first row is its newest run.
  const seen = new Set<string>();
  const ids = rows
    .filter(({ run }) => {
      const newest = !seen.has(run.inputId);
      seen.add(run.inputId);
      const halted = run.state === "ended" && run.outcome !== "completed";
      return !halted || stopped === "all" || (stopped === "newest" && newest);
    })
    .map(({ run }) => run.id);
  const watermarks = ids.length
    ? await tx
        .selectDistinctOn([events.runId], { runId: events.runId, id: events.id })
        .from(events)
        .where(and(inArray(events.runId, ids), inArray(events.type, [...FOLD_EVENT_TYPES])))
        .orderBy(events.runId, desc(events.seq))
    : [];
  // Event identity also changes when the seeder replaces a history at the same sequence.
  const versions = new Map(watermarks.map(({ runId, id }) => [runId, id]));
  const cached = new Map(ids.map((id) => [id, cache.entries.get(id)]));
  const missing = ids.filter((id) => cached.get(id)?.lastEventId !== (versions.get(id) ?? null));
  const { logs, unreadable } = await loadLogs(tx, missing);
  const foldOf = new Map<string, RunFold>();
  const failed: string[] = [];
  for (const id of ids) {
    const lastEventId = versions.get(id) ?? null;
    const hit = cached.get(id);
    let entry: CacheEntry;
    if (hit?.lastEventId === lastEventId) entry = hit;
    else {
      const log = logs.get(id) ?? [];
      entry = {
        lastEventId,
        fold: unreadable.has(id) ? null : foldRun(log),
        weight: log.length + 1,
      };
    }
    if (entry.fold) foldOf.set(id, entry.fold);
    else failed.push(id);
    remember(cache, id, entry);
  }
  if (!skipUnreadable && failed.length)
    throw new Error(`run ${failed.join(", ")}: stored events can't be read`);
  return rows
    .filter(
      // A completed run whose events don't parse, or have no revision, has no review summary,
      // so `runSchema` would throw: in a list it is left out.
      ({ run }) =>
        !skipUnreadable ||
        run.state !== "ended" ||
        run.outcome !== "completed" ||
        foldOf.get(run.id)?.results.summary,
    )
    .map((row) => {
      const fold = foldOf.get(row.run.id) ?? NOTHING;
      return { run: toRun(row, fold.results), generation: row.run.generation, ...fold };
    });
}

/** `loadResults` through one cache, so the run and study reads fold a run once between them. */
export function resultsLoader() {
  const cache = newCache();
  return (tx: Tx, where: SQL | undefined, options: Omit<LoadOptions, "cache"> = {}) =>
    loadResults(tx, where, { ...options, cache });
}
export type ResultsLoader = ReturnType<typeof resultsLoader>;

export async function loadRuns(tx: Tx, where: SQL | undefined): Promise<Run[]> {
  return (await loadResults(tx, where)).map(({ run }) => run);
}

/** The run just written, which must exist. */
export async function loadRun(tx: Tx, runId: string): Promise<Run> {
  const [run] = await loadRuns(tx, eq(runs.id, runId));
  if (!run) throw new Error(`run ${runId} vanished inside its transaction`);
  return run;
}

export function pgRunReads(db: PostgresJsDatabase, results: ResultsLoader) {
  return {
    list: (reader: ReadScope) =>
      db.transaction(
        async (tx) =>
          (await results(tx, readableRuns(reader), { skipUnreadable: true, stopped: "none" })).map(
            ({ run }) => run,
          ),
        { isolationLevel: "repeatable read" },
      ),

    get: async (reader: ReadScope, runId: string) =>
      (
        await db.transaction(
          async (tx) =>
            (
              await results(tx, and(readableRuns(reader), eq(runs.id, runId)))
            ).map(({ run }) => run),
          { isolationLevel: "repeatable read" },
        )
      )[0] ?? null,

    /** Inputs a run can start on: an upload only once completed. */
    async listInputs({ labId, ownerId }: Reader) {
      const rows = await db
        .select()
        .from(inputs)
        .where(and(readableInputs({ labId, ownerId }), eq(inputs.status, "ready")))
        .orderBy(desc(inputs.createdAt), asc(inputs.id));
      return rows.map(toInput);
    },

    /** The one write here: a boot-time seed so a lab member can start a run on the reference scan. */
    async ensureReferenceInputs(labIds: string[]) {
      if (labIds.length === 0) return;
      await db.insert(inputs).values(labIds.map(referenceInput)).onConflictDoNothing();
    },
  };
}

export type RunReads = ReturnType<typeof pgRunReads>;
