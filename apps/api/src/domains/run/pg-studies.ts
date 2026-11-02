/**
 * Postgres adapter for the browser's reads of studies (`@voluma/contracts/study`): Home's
 * list, which carries each input's newest run in brief, and one study with its inputs, runs,
 * values, open checks and each input's task states and open items. Reads apply the caller's `ReadScope` as
 * `pg-runs.ts` does, and fold through its `ResultsLoader`, so a run is folded once for both; the
 * inputs' values, checks and states are read from each fold here. Writes are the queue's.
 */
import { unitAsWritten } from "@voluma/contracts/output-catalog";
import { finalValues, needingYou } from "@voluma/contracts/output-fold";
import { inputNeedsYou, latestRevision, shownTasks } from "@voluma/contracts/review-state";
import type { Run } from "@voluma/contracts/run";
import type {
  Study,
  StudyDetail,
  StudyInput,
  StudyInputDetail,
  StudyRunSummary,
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
import { inputs, runs, studies, studyInputs } from "./schema";

const toStudy = (row: typeof studies.$inferSelect): Study => ({
  id: row.id,
  name: row.name,
  workflowId: row.workflowId,
  budgetUsd: row.budgetUsd,
  example: row.example,
  createdAt: row.createdAt.toISOString(),
});

const completed = ({ state }: Run) => state.status === "ended" && state.outcome === "completed";

/** Each input's newest run (`results` is newest first, so the first seen), and its newest completed run. */
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

/**
 * A completed run's values and acceptable checks: the task loop's from its latest revision, the
 * agent loop's final values from its output fold (it has no checks to accept here).
 */
function resultOf({ run, results }: RunResult) {
  const values: StudyInputDetail["values"] = {};
  const acceptable: StudyInputDetail["acceptable"] = [];
  for (const [id, { number, unit }] of finalValues(results.outputs))
    values[id] = { value: number, unit: unitAsWritten(unit), confidence: null };
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
        acceptable.push({
          runId: run.id,
          taskId: task.id,
          resultRevisionId: task.resultRevisionId,
          checkId: check.id,
          title: check.title,
          detail: check.detail,
        });
    }
  }
  return { values, acceptable };
}

/** A run's review in brief (`runReviewBriefSchema`), of either loop. */
function reviewOf({ run, results }: RunResult): StudyRunSummary["review"] {
  if (run.review) {
    const { acceptable, needsYou, reviewedAt } = run.review;
    return { acceptable, needsYou, reviewedAt };
  }
  if (!completed(run) || run.harness !== "agents") return null;
  return { acceptable: 0, needsYou: needingYou(results.outputs).size, reviewedAt: null };
}

/** The newest run's final outputs' status, for a run of the agent loop; empty otherwise. */
const outputStatusOf = (newest: RunResult | undefined): StudyInputDetail["outputStatus"] =>
  Object.fromEntries(
    (newest?.results.outputs.outputs ?? []).flatMap((o) => (o.final ? [[o.id, o.status]] : [])),
  );

/** The newest run's tasks as the input review shows them (`shownTasks`); none without a run. */
const tasksOf = (newest: RunResult | undefined) =>
  shownTasks(newest && { ...newest, state: newest.run.state, revision: latestRevision(newest) });

function summarize(study: Study, inputCount: number, results: RunResult[]): StudySummary {
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
  let needsYou = 0;
  // Each input as the study page counts it (`needsYouOf`): the same function on the same fields.
  for (const [id, result] of newest) {
    const done = newestCompleted.get(id);
    needsYou += inputNeedsYou(reviewOf(result), done ? resultOf(done).acceptable.length : 0);
  }
  return {
    ...study,
    inputCount,
    inputsCompleted: newestCompleted.size,
    needsYou,
    lastActivityAt,
    newestRuns: [...newest.values()].map(
      (result): StudyRunSummary => ({
        runId: result.run.id,
        inputId: result.run.input.id,
        inputName: result.run.input.name,
        state: result.run.state,
        tasks: result.run.tasks,
        ...(result.run.outputs && { outputs: result.run.outputs }),
        ...(result.run.harness && { harness: result.run.harness }),
        review: reviewOf(result),
        example: result.run.example,
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
            .select({ studyId: studyInputs.studyId, n: sql<number>`count(*)::int` })
            .from(studyInputs)
            .where(inArray(studyInputs.studyId, ids))
            .groupBy(studyInputs.studyId);
          const inputCount = new Map(counts.map(({ studyId, n }) => [studyId, n]));
          const byStudy = new Map<string, RunResult[]>();
          for (const result of await results(
            tx,
            and(readableRuns(reader), inArray(runs.studyId, ids)),
            { skipSummaryless: true, stopped: "none" },
          )) {
            const group = byStudy.get(result.run.studyId) ?? [];
            group.push(result);
            byStudy.set(result.run.studyId, group);
          }
          return rows
            .map((row) =>
              summarize(toStudy(row), inputCount.get(row.id) ?? 0, byStudy.get(row.id) ?? []),
            )
            .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
        },
        { isolationLevel: "repeatable read" },
      ),

    /** One study with its inputs and runs; null when absent or unreadable. */
    get: (reader: ReadScope, studyId: string) =>
      db.transaction(
        async (tx): Promise<StudyDetail | null> => {
          const [row] = await tx
            .select()
            .from(studies)
            .where(and(readableStudies(reader), eq(studies.id, studyId)));
          if (!row) return null;
          const members = await tx
            .select({ member: studyInputs, input: inputs })
            .from(studyInputs)
            .innerJoin(inputs, eq(studyInputs.inputId, inputs.id))
            .where(eq(studyInputs.studyId, studyId))
            .orderBy(asc(studyInputs.position));
          const found = await results(tx, and(readableRuns(reader), eq(runs.studyId, studyId)), {
            skipSummaryless: true,
            stopped: "newest",
          });
          const { newest, newestCompleted } = newestOf(found);
          const runsOf = new Map<string, Run[]>();
          for (const { run } of found) {
            runsOf.set(run.input.id, [...(runsOf.get(run.input.id) ?? []), run]);
          }
          return {
            study: toStudy(row),
            inputs: members.map(({ member, input }) => {
              const result = newestCompleted.get(member.inputId);
              const newestRun = newest.get(member.inputId);
              return {
                member: {
                  inputId: member.inputId,
                  subject: member.subject,
                  group: member.group,
                  attributes: member.attributes,
                } satisfies StudyInput,
                input: toInput(input),
                runs: runsOf.get(member.inputId) ?? [],
                review: newestRun ? reviewOf(newestRun) : null,
                outputStatus: outputStatusOf(newestRun),
                resultRunId: result?.run.id ?? null,
                ...(result ? resultOf(result) : { values: {}, acceptable: [] }),
                ...tasksOf(newestRun),
              };
            }),
          };
        },
        { isolationLevel: "repeatable read" },
      ),
  };
}

export type StudyReads = ReturnType<typeof pgStudyReads>;
