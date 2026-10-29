/**
 * Postgres adapter for the browser's reads of runs and inputs, and the row shapes the
 * queue shares. Reads apply the caller's `Reader` (domain.ts) once, so another org's run
 * is just absent. Every state change is in pg-queue.ts.
 */
import { runEventSchema } from "@voluma/contracts/events";
import type { ReviewSummary } from "@voluma/contracts/review";
import { reviewState } from "@voluma/contracts/review-state";
import { type Input, type Run, runSchema } from "@voluma/contracts/run";
import type { WorkflowPin } from "@voluma/contracts/workflow";
import { and, asc, desc, eq, inArray, or, type SQL, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { EVERY_LAB, type Reader, type ReadScope } from "../../domain";
import type { RunRecord } from "../../ports";
import { events, inputs, referenceInput, runs } from "./schema";

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

function toRun({ run, input, position }: Row, summary: ReviewSummary | null): Run {
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
    review: run.state === "ended" && run.outcome === "completed" ? summary : null,
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
  return tx
    .with(place)
    .select({ run: runs, input: inputs, position: place.position })
    .from(runs)
    .innerJoin(inputs, eq(runs.inputId, inputs.id))
    .leftJoin(place, eq(place.id, runs.id))
    .where(where)
    .orderBy(desc(runs.createdAt), desc(runs.id));
}

async function loadLogs(tx: Tx, ids: string[], summaryOnly = false) {
  const logs = new Map<string, RunRecord["events"]>();
  if (ids.length) {
    const stored = await tx
      .select()
      .from(events)
      .where(
        and(
          inArray(events.runId, ids),
          summaryOnly
            ? inArray(events.type, [
                "thread.started",
                "revision.started",
                "attempt.opened",
                "task",
                "checkpoint",
                "output",
                "check.accepted",
                "review.completed",
              ])
            : undefined,
        ),
      )
      .orderBy(asc(events.seq));
    for (const row of stored) {
      const log = logs.get(row.runId) ?? [];
      log.push(toRunEvent(row));
      logs.set(row.runId, log);
    }
  }
  return logs;
}

export async function loadRecords(
  tx: Tx,
  where: SQL | undefined,
  includeUnfinished = false,
): Promise<RunRecord[]> {
  const rows = await loadRows(tx, where);
  const logs = await loadLogs(
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
    return { run: toRun(row, results.summary), events: log, results };
  });
}

type SummaryCache = Map<string, { lastEventId: string | null; summary: ReviewSummary | null }>;

export async function loadRuns(
  tx: Tx,
  where: SQL | undefined,
  cache: SummaryCache = new Map(),
): Promise<Run[]> {
  const rows = await loadRows(tx, where);
  const ids = rows
    .filter(({ run }) => run.state === "ended" && run.outcome === "completed")
    .map(({ run }) => run.id);
  const watermarks = ids.length
    ? await tx
        .selectDistinctOn([events.runId], { runId: events.runId, id: events.id })
        .from(events)
        .where(inArray(events.runId, ids))
        .orderBy(events.runId, desc(events.seq))
    : [];
  // Event identity also changes when the seeder replaces a history at the same sequence.
  const versions = new Map(watermarks.map(({ runId, id }) => [runId, id]));
  const cachedSummaries = new Map(ids.map((id) => [id, cache.get(id)]));
  const missing = ids.filter(
    (id) => cachedSummaries.get(id)?.lastEventId !== (versions.get(id) ?? null),
  );
  const logs = await loadLogs(tx, missing, true);
  const summaries = new Map<string, ReviewSummary | null>();
  for (const id of ids) {
    const lastEventId = versions.get(id) ?? null;
    const cached = cachedSummaries.get(id);
    const summary =
      cached?.lastEventId === lastEventId
        ? cached.summary
        : reviewState(logs.get(id) ?? []).summary;
    summaries.set(id, summary);
    cache.set(id, { lastEventId, summary });
    // Bound retained summaries; evicted entries are derived again from the event log.
    if (cache.size > 256) cache.delete(cache.keys().next().value as string);
  }
  return rows.map((row) => toRun(row, summaries.get(row.run.id) ?? null));
}

/** The run just written, which must exist. */
export async function loadRun(tx: Tx, runId: string): Promise<Run> {
  const [run] = await loadRuns(tx, eq(runs.id, runId));
  if (!run) throw new Error(`run ${runId} vanished inside its transaction`);
  return run;
}

export function pgRunReads(db: PostgresJsDatabase) {
  // A watermark is read in the same snapshot as the rows/logs, never a TTL or local invalidation.
  const summaries: SummaryCache = new Map();
  return {
    list: (reader: ReadScope) =>
      db.transaction((tx) => loadRuns(tx, readableRuns(reader), summaries), {
        isolationLevel: "repeatable read",
      }),

    get: async (reader: ReadScope, runId: string) =>
      (
        await db.transaction(
          (tx) => loadRuns(tx, and(readableRuns(reader), eq(runs.id, runId)), summaries),
          {
            isolationLevel: "repeatable read",
          },
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
