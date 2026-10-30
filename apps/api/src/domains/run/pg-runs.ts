/**
 * Postgres adapter for the browser's reads of runs and inputs, and the row shapes the
 * queue shares. Reads apply the caller's `Reader` (domain.ts) once, so another org's run
 * is just absent. Every state change is in pg-queue.ts.
 */

import { runEventSchema } from "@voluma/contracts/events";
import type { ReviewSummary } from "@voluma/contracts/review";
import { progress, reviewState } from "@voluma/contracts/review-state";
import { type Input, type Run, runSchema } from "@voluma/contracts/run";
import type { StudyValue, ToCheckItem } from "@voluma/contracts/study";
import type { WorkflowPin } from "@voluma/contracts/workflow";
import { callsOfRuns, type RunCalls } from "@voluma/provider-calls";
import { and, asc, desc, eq, inArray, isNull, lte, or, type SQL, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { EVERY_LAB, type Reader, type ReadScope } from "../../domain";
import type { RunRecord } from "../../ports";
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
  /** The run is queued behind a `provider-outage` hold that has not passed. */
  held: boolean;
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

function toRun(
  { run, input, position, held, calls }: Row,
  { summary, tasks }: Pick<Derived, "summary" | "tasks">,
): Run {
  const iso = (d: Date | null) => d?.toISOString() ?? null;
  const startedAt = iso(run.startedAt);
  const state = ((): Run["state"] => {
    switch (run.state) {
      case "queued":
        return {
          status: "queued",
          position: position ?? 1,
          ...(held &&
            run.claimableAfter && {
              waitingForProvider: { retryAt: run.claimableAfter.toISOString() },
            }),
        };
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
    tasks: run.state === "ended" ? null : tasks,
  });
}

/**
 * Runs matching `where`, newest first. A queued `voluma` run's place is counted here, at
 * read time: its place among its org's queued `voluma` runs, oldest first. A visitor run
 * waits only for a runner, so its place is 1. A run held back after a provider outage takes
 * no place and counts for none.
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
      .where(
        and(
          eq(runs.state, "queued"),
          eq(runs.credentials, "voluma"),
          // A held run is not ahead of anyone: the claim skips it.
          or(isNull(runs.claimableAfter), lte(runs.claimableAfter, sql`now()`)),
        ),
      ),
  );
  const rows = await tx
    .with(place)
    .select({
      run: runs,
      input: inputs,
      position: place.position,
      held: sql<boolean>`coalesce(${runs.claimableAfter} > now(), false)`,
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

/** The event types `reviewState` reads, so a live run changes its derived results only when one of them is written. */
const SUMMARY_TYPES = [
  "thread.started",
  "revision.started",
  "attempt.opened",
  "task",
  "plan.changed",
  "checkpoint",
  "output",
  "check.accepted",
  "review.completed",
  "run.reopened",
  "correction.ended",
  "thread.ended",
] as const;

async function loadLogs(tx: Tx, ids: string[], summaryOnly = false) {
  const logs = new Map<string, RunRecord["events"]>();
  const unreadable = new Set<string>();
  if (ids.length) {
    const stored = await tx
      .select()
      .from(events)
      .where(
        and(
          inArray(events.runId, ids),
          summaryOnly ? inArray(events.type, [...SUMMARY_TYPES]) : undefined,
        ),
      )
      .orderBy(asc(events.seq));
    // Rows an older build wrote cross a trust boundary. With `summaryOnly` a run whose events
    // no longer parse is reported in `unreadable` instead of throwing, so `loadRuns` decides
    // what that means for its caller.
    for (const row of stored) {
      if (unreadable.has(row.runId)) continue;
      try {
        const log = logs.get(row.runId) ?? [];
        log.push(toRunEvent(row));
        logs.set(row.runId, log);
      } catch (error) {
        if (!summaryOnly) throw error;
        unreadable.add(row.runId);
        logs.delete(row.runId);
        console.error(`run ${row.runId}: event ${row.id} (${row.type}) does not parse:`, error);
      }
    }
  }
  return { logs, unreadable };
}

export async function loadRecords(
  tx: Tx,
  where: SQL | undefined,
  includeUnfinished = false,
): Promise<RunRecord[]> {
  const rows = await loadRows(tx, where);
  const { logs } = await loadLogs(
    tx,
    rows
      .filter(
        ({ run }) => includeUnfinished || (run.state === "ended" && run.outcome === "completed"),
      )
      .map(({ run }) => run.id),
  );
  return rows.map((row) => {
    const log = logs.get(row.run.id) ?? [];
    const results = reviewState(log);
    return {
      generation: row.run.generation,
      run: toRun(row, { summary: results.summary, tasks: progressOf(results.revisions.at(-1)) }),
      events: log,
      results,
    };
  });
}

/**
 * What one `reviewState(log)` gives the reads: for a completed run the summary, and for
 * studies its measurement values and open checks; for a live run its task progress.
 */
type Derived = {
  summary: ReviewSummary | null;
  tasks: Run["tasks"];
  /** Output id (`outputs.json`) → value, from the latest revision's tasks. */
  values: Record<string, StudyValue>;
  toCheck: Omit<ToCheckItem, "runId">[];
};

const NOTHING: Derived = { summary: null, tasks: null, values: {}, toCheck: [] };

type Revision = ReturnType<typeof reviewState>["revisions"][number];

/** A revision's finished tasks out of its plan's; null before there is a revision. */
function progressOf(latest: Revision | undefined): Run["tasks"] {
  if (!latest) return null;
  const { done, total } = progress(latest);
  return { done, total };
}

function derive(log: RunRecord["events"]): Derived {
  const { summary, revisions } = reviewState(log);
  const latest = revisions.at(-1);
  const values: Derived["values"] = {};
  const toCheck: Derived["toCheck"] = [];
  for (const task of latest?.tasks ?? []) {
    for (const m of task.measurements) {
      // The fold names a measurement `taskId/outputId`; the workflow files know the output id.
      values[m.id.slice(task.id.length + 1)] = {
        value: m.value,
        unit: m.unit,
        confidence: m.confidence,
      };
    }
    for (const check of task.checks) {
      if (check.status === "open") {
        toCheck.push({
          taskId: task.id,
          checkId: check.id,
          title: check.title,
          detail: check.detail,
        });
      }
    }
  }
  return { summary, tasks: progressOf(latest), values, toCheck };
}

type SummaryCache = Map<string, { lastEventId: string | null; derived: Derived }>;

/** The most derived results kept, least recently read out first; evicted ones are derived again from the event log. */
const CACHE_CAP = 2048;

export type RunResult = { run: Run } & Derived;

interface LoadOptions {
  cache?: SummaryCache;
  /**
   * The lists and the study reads: a completed run whose events no longer parse is left out
   * rather than failing every run listed with it. Without it (one run's read) it throws: the
   * run's own page must fail loudly, not read as "no plan" (a 409 the web polls forever).
   * A completed run with no revision is left out the same way. A live run whose events
   * don't parse is always kept, with `tasks: null`: it still runs.
   */
  skipUnreadable?: boolean;
}

async function loadResults(
  tx: Tx,
  where: SQL | undefined,
  { cache = new Map(), skipUnreadable = false }: LoadOptions = {},
): Promise<RunResult[]> {
  const rows = await loadRows(tx, where);
  const ended = new Set(rows.filter(({ run }) => run.state === "ended").map(({ run }) => run.id));
  const ids = rows
    // A failed or cancelled run has nothing to derive; a live one has its `tasks`.
    .filter(({ run }) => run.state !== "ended" || run.outcome === "completed")
    .map(({ run }) => run.id);
  const watermarks = ids.length
    ? await tx
        .selectDistinctOn([events.runId], { runId: events.runId, id: events.id })
        .from(events)
        .where(and(inArray(events.runId, ids), inArray(events.type, [...SUMMARY_TYPES])))
        .orderBy(events.runId, desc(events.seq))
    : [];
  // Event identity also changes when the seeder replaces a history at the same sequence.
  const versions = new Map(watermarks.map(({ runId, id }) => [runId, id]));
  const cached = new Map(ids.map((id) => [id, cache.get(id)]));
  const missing = ids.filter((id) => cached.get(id)?.lastEventId !== (versions.get(id) ?? null));
  const { logs, unreadable } = await loadLogs(tx, missing, true);
  const lost = [...unreadable].filter((id) => ended.has(id));
  if (!skipUnreadable && lost.length)
    throw new Error(`run ${lost.join(", ")}: stored events can't be read`);
  const derivedOf = new Map<string, Derived>();
  for (const id of ids) {
    if (unreadable.has(id)) continue;
    const lastEventId = versions.get(id) ?? null;
    const hit = cached.get(id);
    const derived = hit?.lastEventId === lastEventId ? hit.derived : derive(logs.get(id) ?? []);
    derivedOf.set(id, derived);
    // Delete first, so the entry goes last in the map's insertion order.
    cache.delete(id);
    cache.set(id, { lastEventId, derived });
    if (cache.size > CACHE_CAP) cache.delete(cache.keys().next().value as string);
  }
  return rows
    .filter(({ run }) => !lost.includes(run.id))
    .filter(
      // A completed run whose events have no revision has no review summary, so `runSchema`
      // would throw: in a list it is as unreadable as one whose events don't parse.
      ({ run }) =>
        !skipUnreadable ||
        run.state !== "ended" ||
        run.outcome !== "completed" ||
        derivedOf.get(run.id)?.summary,
    )
    .map((row) => {
      const derived = derivedOf.get(row.run.id) ?? NOTHING;
      return { run: toRun(row, derived), ...derived };
    });
}

/** `loadResults` through one cache, so the run and study reads derive a run once between them. */
export function resultsLoader() {
  const cache: SummaryCache = new Map();
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
          (await results(tx, readableRuns(reader), { skipUnreadable: true })).map(({ run }) => run),
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
