/**
 * Postgres adapter for the browser's reads of studies (`@voluma/contracts/study`): Home's
 * list, which carries each scan's newest run in brief, and one study with its scans, runs,
 * values, open checks and each scan's task states. Reads apply the caller's `ReadScope` as
 * `pg-runs.ts` does, and fold through its `ResultsLoader`, so a run is folded once for both; the
 * scans' values, checks and states are read from each fold here. Writes are the queue's.
 */
import { type RunHalt, taskStates } from "@voluma/contracts/review-state";
import type { Run } from "@voluma/contracts/run";
import type {
  Study,
  StudyDetail,
  StudyRunSummary,
  StudyScan,
  StudyScanDetail,
  StudySummary,
} from "@voluma/contracts/study";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { ReadScope } from "../../domain";
import {
  type ResultsLoader,
  type RunResult,
  readableRuns,
  readableStudies,
  toInput,
} from "./pg-runs";
import { inputs, runs, studies, studyScans } from "./schema";

const toStudy = (row: typeof studies.$inferSelect): Study => ({
  id: row.id,
  name: row.name,
  workflowId: row.workflowId,
  budgetUsd: row.budgetUsd,
  example: row.example,
  createdAt: row.createdAt.toISOString(),
});

const completed = ({ state }: Run) => state.status === "ended" && state.outcome === "completed";

/** Each scan's newest run (`results` is newest first, so the first seen), and its newest completed run. */
function newestOf(results: RunResult[]) {
  const newest = new Map<string, RunResult>();
  const newestCompleted = new Map<string, RunResult>();
  for (const result of results) {
    const id = result.run.input.id;
    if (!newest.has(id)) newest.set(id, result);
    if (completed(result.run) && !newestCompleted.has(id)) newestCompleted.set(id, result);
  }
  return { newest, newestCompleted };
}

/** A completed run's measurement values and open checks, from its latest revision. */
function resultOf({ run, results }: RunResult) {
  const values: StudyScanDetail["values"] = {};
  const toCheck: StudyScanDetail["toCheck"] = [];
  for (const task of results.revisions.at(-1)?.tasks ?? []) {
    for (const m of task.measurements) {
      // The fold names a measurement `taskId/outputId`; the workflow files know the output id.
      values[m.id.slice(task.id.length + 1)] = {
        value: m.value,
        unit: m.unit,
        confidence: m.confidence,
      };
    }
    for (const check of task.checks) {
      if (check.status === "open")
        toCheck.push({
          runId: run.id,
          taskId: task.id,
          checkId: check.id,
          title: check.title,
          detail: check.detail,
        });
    }
  }
  return { values, toCheck };
}

/** Where a run stands for its tasks, as the run page reads it from the same state. */
function haltOf({ state }: Run): RunHalt {
  switch (state.status) {
    case "running":
      return undefined;
    case "queued":
    case "awaiting-keys":
      return "paused";
    case "ended":
      return "stopped";
  }
}

/** Every task of a run's latest plan in its state; none before a plan. */
function taskStateOf({ run, results, open, failed }: RunResult): StudyScanDetail["taskState"] {
  const latest = results.revisions.at(-1);
  if (!latest) return {};
  const { state } = run;
  const states = taskStates(latest, {
    running: new Set(state.status === "running" ? open : []),
    failed: state.status === "ended" && state.outcome === "failed" ? failed : new Set(),
    halt: haltOf(run),
  });
  return Object.fromEntries(states);
}

function summarize(study: Study, scanCount: number, results: RunResult[]): StudySummary {
  const { newest, newestCompleted } = newestOf(results);
  let lastActivityAt = study.createdAt;
  for (const { run } of results) {
    for (const at of [
      run.createdAt,
      "startedAt" in run.state && run.state.startedAt,
      "endedAt" in run.state && run.state.endedAt,
    ]) {
      if (at && at > lastActivityAt) lastActivityAt = at;
    }
  }
  let toCheck = 0;
  for (const { run } of newestCompleted.values()) toCheck += run.review?.remainingToCheck ?? 0;
  return {
    ...study,
    scanCount,
    scansCompleted: newestCompleted.size,
    toCheck,
    lastActivityAt,
    newestRuns: [...newest.values()].map(
      ({ run }): StudyRunSummary => ({
        runId: run.id,
        inputId: run.input.id,
        inputName: run.input.name,
        state: run.state,
        tasks: run.tasks,
        review: run.review && {
          remainingToCheck: run.review.remainingToCheck,
          reviewedAt: run.review.reviewedAt,
        },
        example: run.example,
      }),
    ),
  };
}

export function pgStudyReads(db: PostgresJsDatabase, results: ResultsLoader) {
  return {
    /** The caller's readable studies, newest activity first. */
    list: (reader: ReadScope) =>
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
          const byStudy = new Map<string, RunResult[]>();
          for (const result of await results(
            tx,
            and(readableRuns(reader), inArray(runs.studyId, ids)),
            { skipUnreadable: true, stopped: "none" },
          )) {
            const group = byStudy.get(result.run.studyId) ?? [];
            group.push(result);
            byStudy.set(result.run.studyId, group);
          }
          return rows
            .map((row) =>
              summarize(toStudy(row), scanCount.get(row.id) ?? 0, byStudy.get(row.id) ?? []),
            )
            .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
        },
        { isolationLevel: "repeatable read" },
      ),

    /** One study with its scans and runs; null when absent or unreadable. */
    get: (reader: ReadScope, studyId: string) =>
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
          const found = await results(tx, and(readableRuns(reader), eq(runs.studyId, studyId)), {
            skipUnreadable: true,
            stopped: "newest",
          });
          const { newest, newestCompleted } = newestOf(found);
          const runsOf = new Map<string, Run[]>();
          for (const { run } of found) {
            runsOf.set(run.input.id, [...(runsOf.get(run.input.id) ?? []), run]);
          }
          return {
            study: toStudy(row),
            scans: scans.map(({ scan, input }) => {
              const result = newestCompleted.get(scan.inputId);
              const newestRun = newest.get(scan.inputId);
              return {
                scan: {
                  inputId: scan.inputId,
                  subject: scan.subject,
                  group: scan.group,
                  attributes: scan.attributes,
                } satisfies StudyScan,
                input: toInput(input),
                runs: runsOf.get(scan.inputId) ?? [],
                resultRunId: result?.run.id ?? null,
                ...(result ? resultOf(result) : { values: {}, toCheck: [] }),
                taskState: newestRun ? taskStateOf(newestRun) : {},
              };
            }),
          };
        },
        { isolationLevel: "repeatable read" },
      ),
  };
}

export type StudyReads = ReturnType<typeof pgStudyReads>;
