/**
 * Postgres adapter for the browser's reads of studies (`@voluma/contracts/study`): Home's
 * list, which carries each input's newest run in brief, and one study with its inputs, runs,
 * values and each input's newest outputs. Reads apply the caller's `ReadScope` as
 * `pg-runs.ts` does, and fold through its `ResultsLoader`, so a run is folded once for both; the
 * inputs' values and output statuses are read from each fold here. Writes are the queue's.
 *
 * A run's `waiting` is the open calls its fold counted, kept only when the caller can answer
 * them (`CanAnswer`): the rule the run read applies as `cannotMessage`.
 */
import { unitAsWritten } from "@voluma/contracts/output-catalog";
import { finalValues } from "@voluma/contracts/output-fold";
import type { Run } from "@voluma/contracts/run";
import type {
  Study,
  StudyDetail,
  StudyInputDetail,
  StudyMember,
  StudyRunSummary,
  StudySummary,
} from "@voluma/contracts/study";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { ReadScope } from "../../domain";
import {
  type Queryable,
  type ResultsLoader,
  type RunResult,
  readableRuns,
  readableStudies,
  toInput,
} from "./pg-runs";
import { inputs, runs, studies, studyMembers } from "./schema";

const toStudy = (row: typeof studies.$inferSelect): Study => ({
  id: row.id,
  name: row.name,
  workflowId: row.workflowId,
  budgetUsd: row.budgetUsd,
  example: row.example,
  createdAt: row.createdAt.toISOString(),
});

/** Whether the caller may answer this run's held calls: the run read's `cannotMessage` is null. */
export type CanAnswer = (tx: Queryable, run: Run, workflowId: string) => Promise<boolean>;

/** A run's open calls the caller can answer; the check runs only for a run that holds any. */
async function waitingOf(
  tx: Queryable,
  workflowId: string,
  { run, waiting }: RunResult,
  canAnswer: CanAnswer,
) {
  return waiting > 0 && (await canAnswer(tx, run, workflowId)) ? waiting : 0;
}

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

/** A completed run's final values: each final output's latest number, its unit as people write it. */
function valuesOf({ results }: RunResult) {
  const values: StudyInputDetail["values"] = {};
  for (const [id, { number, unit }] of finalValues(results.outputs))
    values[id] = { value: number, unit: unitAsWritten(unit) };
  return values;
}

/** A completed run's review in brief (`runReviewBriefSchema`). */
function reviewOf({ run, results }: RunResult): StudyRunSummary["review"] {
  return completed(run) ? { needsYou: results.outputs.toCheck } : null;
}

/** The newest run's final outputs' status; empty without a run. */
const outputStatusOf = (newest: RunResult | undefined): StudyInputDetail["outputStatus"] =>
  Object.fromEntries(
    (newest?.results.outputs.outputs ?? []).flatMap((o) => (o.final ? [[o.id, o.status]] : [])),
  );

async function summarize(
  tx: Queryable,
  study: Study,
  inputCount: number,
  results: RunResult[],
  canAnswer: CanAnswer,
): Promise<StudySummary> {
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
  return {
    ...study,
    inputCount,
    inputsCompleted: newestCompleted.size,
    lastActivityAt,
    newestRuns: await Promise.all(
      [...newest.values()].map(
        async (result): Promise<StudyRunSummary> => ({
          runId: result.run.id,
          inputId: result.run.input.id,
          inputName: result.run.input.name,
          state: result.run.state,
          ...(result.run.outputs && { outputs: result.run.outputs }),
          review: reviewOf(result),
          waiting: await waitingOf(tx, study.workflowId, result, canAnswer),
          example: result.run.example,
        }),
      ),
    ),
  };
}

export function pgStudyReads(db: PostgresJsDatabase, results: ResultsLoader) {
  return {
    /** The caller's readable studies, newest activity first. */
    list: (reader: ReadScope, canAnswer: CanAnswer) =>
      db.transaction(
        async (tx): Promise<StudySummary[]> => {
          const rows = await tx.select().from(studies).where(readableStudies(reader));
          if (rows.length === 0) return [];
          const ids = rows.map((row) => row.id);
          const counts = await tx
            .select({ studyId: studyMembers.studyId, n: sql<number>`count(*)::int` })
            .from(studyMembers)
            .where(inArray(studyMembers.studyId, ids))
            .groupBy(studyMembers.studyId);
          const inputCount = new Map(counts.map(({ studyId, n }) => [studyId, n]));
          const byStudy = new Map<string, RunResult[]>();
          for (const result of await results(
            tx,
            and(readableRuns(reader), inArray(runs.studyId, ids)),
            { stopped: "none" },
          )) {
            const group = byStudy.get(result.run.studyId) ?? [];
            group.push(result);
            byStudy.set(result.run.studyId, group);
          }
          const summaries = await Promise.all(
            rows.map((row) =>
              summarize(
                tx,
                toStudy(row),
                inputCount.get(row.id) ?? 0,
                byStudy.get(row.id) ?? [],
                canAnswer,
              ),
            ),
          );
          return summaries.sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
        },
        { isolationLevel: "repeatable read" },
      ),

    /** One study with its inputs and runs; null when absent or unreadable. */
    get: (reader: ReadScope, studyId: string, canAnswer: CanAnswer) =>
      db.transaction(
        async (tx): Promise<StudyDetail | null> => {
          const [row] = await tx
            .select()
            .from(studies)
            .where(and(readableStudies(reader), eq(studies.id, studyId)));
          if (!row) return null;
          const members = await tx
            .select({ member: studyMembers, input: inputs })
            .from(studyMembers)
            .innerJoin(inputs, eq(studyMembers.inputId, inputs.id))
            .where(eq(studyMembers.studyId, studyId))
            .orderBy(asc(studyMembers.position));
          const found = await results(tx, and(readableRuns(reader), eq(runs.studyId, studyId)), {
            stopped: "newest",
          });
          const { newest, newestCompleted } = newestOf(found);
          const runsOf = new Map<string, Run[]>();
          for (const { run } of found) {
            runsOf.set(run.input.id, [...(runsOf.get(run.input.id) ?? []), run]);
          }
          const waiting = new Map(
            await Promise.all(
              [...newest].map(
                async ([inputId, r]) =>
                  [inputId, await waitingOf(tx, row.workflowId, r, canAnswer)] as const,
              ),
            ),
          );
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
                } satisfies StudyMember,
                input: toInput(input),
                runs: runsOf.get(member.inputId) ?? [],
                review: newestRun ? reviewOf(newestRun) : null,
                waiting: waiting.get(member.inputId) ?? 0,
                outputStatus: outputStatusOf(newestRun),
                resultRunId: result?.run.id ?? null,
                values: result ? valuesOf(result) : {},
              };
            }),
          };
        },
        { isolationLevel: "repeatable read" },
      ),
  };
}

export type StudyReads = ReturnType<typeof pgStudyReads>;
