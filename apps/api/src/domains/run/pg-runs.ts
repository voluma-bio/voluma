/**
 * Postgres adapter for the browser's reads of runs and inputs, and the row shapes the
 * queue shares. Reads apply the caller's `Reader` (domain.ts) once, so another org's run
 * is just absent. Every state change is in pg-queue.ts.
 */

import { runEventSchema } from "@voluma/contracts/events";
import type { ReviewSummary } from "@voluma/contracts/review";
import { reviewState } from "@voluma/contracts/review-state";
import { type Input, type Run, runSchema } from "@voluma/contracts/run";
import type {
  Study,
  StudyDetail,
  StudyScan,
  StudySummary,
  StudyValue,
  ToCheckItem,
} from "@voluma/contracts/study";
import type { WorkflowPin } from "@voluma/contracts/workflow";
import { callsOfRuns, type RunCalls } from "@voluma/provider-calls";
import { and, asc, desc, eq, inArray, or, type SQL, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { EVERY_LAB, type Reader, type ReadScope } from "../../domain";
import type { RunRecord } from "../../ports";
import { events, inputs, referenceInput, runs, studies, studyScans } from "./schema";

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

function toRun(
  { run, input, position, calls }: Row,
  { summary, tasks }: Pick<Derived, "summary" | "tasks">,
): Run {
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
    forkedFrom: run.forkedFrom,
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
    .select({ run: runs, input: inputs, position: place.position })
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
    calls: calls.get(row.run.id) ?? { costUsd: 0, calls: 0, bySandbox: [] },
  }));
}

/** The event types `reviewState` reads: the summary, a study's values and a live run's progress. */
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
    return { run: toRun(row, { summary: results.summary, tasks: null }), events: log, results };
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

function derive(log: RunRecord["events"]): Derived {
  const { summary, revisions } = reviewState(log);
  const latest = revisions.at(-1);
  // The fold has a row only for a task that started; the plan lists them all. "Finished"
  // counts To check tasks: their work is done (the run page counts the same).
  const tasks = latest && {
    done: latest.tasks.filter((t) => t.status === "done" || t.status === "to-check").length,
    total: latest.plan.tasks.length,
  };
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
  return { summary, tasks: tasks ?? null, values, toCheck };
}

type SummaryCache = Map<string, { lastEventId: string | null; derived: Derived }>;

/** The most derived results kept; evicted ones are derived again from the event log. */
const CACHE_CAP = 2048;

type RunResult = { run: Run } & Derived;

interface LoadOptions {
  cache?: SummaryCache;
  /**
   * The lists and the study read: a completed run whose events no longer parse is left out rather than failing
   * every run listed with it. Without it (one run's read) it throws: the run's own page must
   * fail loudly, not read as "no plan" (a 409 the web polls forever).
   */
  skipUnreadable?: boolean;
  /** Derive a live run's `tasks` (Home and the study page show them); else it reads null. */
  progress?: boolean;
}

async function loadResults(
  tx: Tx,
  where: SQL | undefined,
  { cache = new Map(), skipUnreadable = false, progress = false }: LoadOptions = {},
): Promise<RunResult[]> {
  const rows = await loadRows(tx, where);
  // A failed or cancelled run has nothing derived; a live one only its progress.
  const ids = rows
    .filter(({ run }) => (run.state === "ended" ? run.outcome === "completed" : progress))
    .map(({ run }) => run.id);
  // The newest event `reviewState` reads, so a live run misses the cache only when a task
  // changes, not on every log line it writes.
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
  if (!skipUnreadable && unreadable.size)
    throw new Error(`run ${[...unreadable].join(", ")}: stored events can't be read`);
  const derivedOf = new Map<string, Derived>();
  for (const id of ids) {
    if (unreadable.has(id)) continue;
    const lastEventId = versions.get(id) ?? null;
    const hit = cached.get(id);
    const derived = hit?.lastEventId === lastEventId ? hit.derived : derive(logs.get(id) ?? []);
    derivedOf.set(id, derived);
    cache.set(id, { lastEventId, derived });
    if (cache.size > CACHE_CAP) cache.delete(cache.keys().next().value as string);
  }
  return rows
    .filter(({ run }) => !unreadable.has(run.id))
    .map((row) => {
      const derived = derivedOf.get(row.run.id) ?? NOTHING;
      return { run: toRun(row, derived), ...derived };
    });
}

export async function loadRuns(
  tx: Tx,
  where: SQL | undefined,
  options?: LoadOptions,
): Promise<Run[]> {
  return (await loadResults(tx, where, options)).map(({ run }) => run);
}

/** The run just written, which must exist. */
export async function loadRun(tx: Tx, runId: string): Promise<Run> {
  const [run] = await loadRuns(tx, eq(runs.id, runId));
  if (!run) throw new Error(`run ${runId} vanished inside its transaction`);
  return run;
}

const toStudy = (row: typeof studies.$inferSelect): Study => ({
  id: row.id,
  labId: row.labId,
  name: row.name,
  workflowId: row.workflowId,
  budgetUsd: row.budgetUsd,
  createdBy: row.createdBy,
  example: row.example,
  createdAt: row.createdAt.toISOString(),
});

function pickValues(values: Derived["values"] = {}, outputs: readonly string[]): Derived["values"] {
  const picked: Derived["values"] = {};
  for (const id of outputs) {
    const value = values[id];
    if (value) picked[id] = value;
  }
  return picked;
}

/** Each scan's newest completed run: `results` is newest first, so the first completed one seen. */
function newestCompleted(results: RunResult[]): Map<string, RunResult> {
  const newest = new Map<string, RunResult>();
  for (const result of results) {
    const { state, input } = result.run;
    if (state.status === "ended" && state.outcome === "completed" && !newest.has(input.id)) {
      newest.set(input.id, result);
    }
  }
  return newest;
}

function summarize(study: Study, scanCount: number, results: RunResult[]): StudySummary {
  const runCounts = {
    queued: 0,
    running: 0,
    awaitingKeys: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
  };
  let lastActivity = study.createdAt;
  for (const { run } of results) {
    const { state } = run;
    if (state.status === "ended") runCounts[state.outcome]++;
    else if (state.status === "awaiting-keys") runCounts.awaitingKeys++;
    else runCounts[state.status]++;
    for (const at of [
      run.createdAt,
      "startedAt" in state && state.startedAt,
      "endedAt" in state && state.endedAt,
    ]) {
      if (at && at > lastActivity) lastActivity = at;
    }
  }
  let toCheck = 0;
  for (const { toCheck: items } of newestCompleted(results).values()) toCheck += items.length;
  return { ...study, scanCount, runCounts, toCheck, lastActivityAt: lastActivity };
}

export function pgRunReads(db: PostgresJsDatabase) {
  // A watermark is read in the same snapshot as the rows/logs, never a TTL or local invalidation.
  const summaries: SummaryCache = new Map();
  return {
    list: (reader: ReadScope) =>
      db.transaction(
        (tx) =>
          loadRuns(tx, readableRuns(reader), {
            cache: summaries,
            skipUnreadable: true,
            progress: true,
          }),
        {
          isolationLevel: "repeatable read",
        },
      ),

    get: async (reader: ReadScope, runId: string) =>
      (
        await db.transaction(
          (tx) => loadRuns(tx, and(readableRuns(reader), eq(runs.id, runId)), { cache: summaries }),
          {
            isolationLevel: "repeatable read",
          },
        )
      )[0] ?? null,

    /** The caller's readable studies, newest activity first. */
    studies: (reader: ReadScope) =>
      db.transaction(
        async (tx): Promise<StudySummary[]> => {
          const rows = await tx.select().from(studies).where(readableStudies(reader));
          if (rows.length === 0) return [];
          const ids = rows.map((row) => row.id);
          const counts = await tx
            .select({ studyId: studyScans.studyId, n: sql<number>`count(*)::int` })
            .from(studyScans)
            .where(inArray(studyScans.studyId, ids))
            .groupBy(studyScans.studyId);
          const scanCount = new Map(counts.map(({ studyId, n }) => [studyId, n]));
          const results = await loadResults(
            tx,
            and(readableRuns(reader), inArray(runs.studyId, ids)),
            { cache: summaries, skipUnreadable: true },
          );
          return rows
            .map((row) =>
              summarize(
                toStudy(row),
                scanCount.get(row.id) ?? 0,
                results.filter(({ run }) => run.studyId === row.id),
              ),
            )
            .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
        },
        { isolationLevel: "repeatable read" },
      ),

    /** One study with its scans and runs; `outputs` picks the values to include. Null when absent or unreadable. */
    study: (reader: ReadScope, studyId: string, outputs: readonly string[]) =>
      db.transaction(
        async (tx): Promise<StudyDetail | null> => {
          const [row] = await tx
            .select()
            .from(studies)
            .where(and(readableStudies(reader), eq(studies.id, studyId)));
          if (!row) return null;
          const scans = await tx
            .select({ scan: studyScans, input: inputs })
            .from(studyScans)
            .innerJoin(inputs, eq(studyScans.inputId, inputs.id))
            .where(eq(studyScans.studyId, studyId))
            .orderBy(asc(studyScans.position));
          const results = await loadResults(
            tx,
            and(readableRuns(reader), eq(runs.studyId, studyId)),
            { cache: summaries, skipUnreadable: true, progress: true },
          );
          const newest = newestCompleted(results);
          return {
            study: toStudy(row),
            scans: scans.map(({ scan, input }) => {
              const result = newest.get(scan.inputId);
              return {
                scan: {
                  inputId: scan.inputId,
                  subject: scan.subject,
                  group: scan.group,
                  attributes: scan.attributes,
                  position: scan.position,
                } satisfies StudyScan,
                input: toInput(input),
                runs: results
                  .filter(({ run }) => run.input.id === scan.inputId)
                  .map(({ run }) => run),
                resultRunId: result?.run.id ?? null,
                values: pickValues(result?.values, outputs),
                toCheck: (result?.toCheck ?? []).map((item) => ({
                  ...item,
                  runId: result?.run.id as string,
                })),
              };
            }),
          };
        },
        { isolationLevel: "repeatable read" },
      ),

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
