/**
 * Postgres adapter for the RunStore port: the browser's side of a run. Reads apply the
 * `Reader` (run-rows.ts); a write reads through it first, so another org's run is
 * `not-found`. Start takes the queue lock so the limit counts can't race a claim.
 */
import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { spentToday, startedToday, visitorActiveCount, waitingCount } from "./pg-limits";
import {
  countRuns,
  loadRun,
  loadRuns,
  QUEUE_LOCK,
  readableInputs,
  readableRuns,
  toInput,
} from "./run-rows";
import type { LimitsOf, RunStore } from "./run-store";
import { inputs, runs } from "./schema";

/** The scan every org may start from: one row per org, uploaded by the examples operator. */
export const EXAMPLES_OPERATOR = "voluma-examples";
export const referenceInputId = (labId: string) => `reference-${labId}`;

export function pgRunStore(db: PostgresJsDatabase, limitsOf: LimitsOf): RunStore {
  return {
    list: (reader) => db.transaction((tx) => loadRuns(tx, readableRuns(reader))),

    get: async (reader, runId) =>
      (
        await db.transaction((tx) => loadRuns(tx, and(readableRuns(reader), eq(runs.id, runId))))
      )[0] ?? null,

    async listInputs({ labId, ownerId }) {
      const rows = await db
        .select()
        .from(inputs)
        .where(
          and(
            eq(inputs.labId, labId),
            ownerId === null ? undefined : eq(inputs.uploadedBy, ownerId),
          ),
        )
        .orderBy(desc(inputs.createdAt), asc(inputs.id));
      return rows.map(toInput);
    },

    start: (reader, { userId }, request) =>
      db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(${QUEUE_LOCK})`);
        const [input] = await tx
          .select({ id: inputs.id })
          .from(inputs)
          .where(and(readableInputs(reader), eq(inputs.id, request.inputId)));
        if (!input) return { refused: "no-input" as const };
        const limits = limitsOf(reader.labId);
        if (!limits) return { refused: "unknown-org" as const };
        const unfinished = await countRuns(
          tx,
          and(
            eq(runs.startedBy, userId),
            eq(runs.credentials, request.credentials),
            sql`${runs.state} <> 'ended'`,
          ),
        );
        if (limits.perCaller !== null && unfinished >= limits.perCaller) {
          return { refused: "per-caller" as const };
        }
        if (
          request.credentials === "visitor" &&
          limits.visitorActive !== null &&
          (await visitorActiveCount(tx, reader.labId)) >= limits.visitorActive
        ) {
          return { refused: "visitor-active" as const };
        }
        if (request.credentials === "voluma") {
          if (limits.perDay !== null) {
            const used =
              (await startedToday(tx, reader.labId)) + (await waitingCount(tx, reader.labId));
            if (used >= limits.perDay) return { refused: "daily" as const };
          }
          if (
            limits.usdPerDay !== null &&
            (await spentToday(tx, reader.labId)) >= limits.usdPerDay
          ) {
            return { refused: "dollar" as const };
          }
        }
        await tx.insert(runs).values({
          id: request.id,
          labId: reader.labId,
          startedBy: userId,
          workflowId: request.workflowId,
          workflows: request.pins,
          inputId: request.inputId,
          credentials: request.credentials,
          state: "queued",
        });
        return { run: await loadRun(tx, request.id) };
      }),

    cancel: (reader, runId) =>
      db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(${QUEUE_LOCK})`);
        const [run] = await loadRuns(tx, and(readableRuns(reader), eq(runs.id, runId)));
        if (!run) return "not-found";
        if (run.example) return "example";
        if (run.state.status === "ended") return run;
        await tx
          .update(runs)
          .set({ state: "ended", outcome: "cancelled", endedAt: sql`now()` })
          .where(eq(runs.id, runId));
        return loadRun(tx, runId);
      }),

    resume: (reader, userId, runId, holdKeys) =>
      db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(${QUEUE_LOCK})`);
        const [run] = await loadRuns(tx, and(readableRuns(reader), eq(runs.id, runId)));
        if (!run) return "not-found";
        if (run.startedBy !== userId) return "forbidden";
        if (run.state.status !== "awaiting-keys") return "conflict";
        const limits = limitsOf(reader.labId);
        if (
          limits?.visitorActive != null &&
          (await visitorActiveCount(tx, reader.labId)) >= limits.visitorActive
        ) {
          return "visitor-active";
        }
        if (!holdKeys()) return "full";
        await tx
          .update(runs)
          .set({ state: "queued", awaitingSince: null })
          .where(eq(runs.id, runId));
        return loadRun(tx, runId);
      }),

    async ensureReferenceInputs(labIds) {
      if (labIds.length === 0) return;
      await db
        .insert(inputs)
        .values(
          labIds.map((labId) => ({
            id: referenceInputId(labId),
            labId,
            source: "reference" as const,
            uploadedBy: EXAMPLES_OPERATOR,
            name: "OA6-1RK (mouse knee)",
          })),
        )
        .onConflictDoNothing();
    },
  };
}
