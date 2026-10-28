/**
 * What the run store and the queue share: the transaction type, the reader filters,
 * run rows as `Run`s, and the lease check every ingest write makes.
 */
import type { Input, Run } from "@voluma/contracts/run";
import type { WorkflowPin } from "@voluma/contracts/workflow";
import { and, desc, eq, exists, lt, or, type SQL, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { Reader } from "../../domain";
import { LeaseLost } from "./run-store";
import { inputs, runs } from "./schema";

export type Tx = Parameters<Parameters<PostgresJsDatabase["transaction"]>[0]>[0];

/** Serializes every transaction that decides admission (start, claim), so the counts can't race. */
export const QUEUE_LOCK = 0x76_6f_6c_71;

/** `lab_id = labId AND (ownerId IS NULL OR started_by = ownerId OR example)` */
export const readableRuns = ({ labId, ownerId }: Reader): SQL | undefined =>
  and(
    eq(runs.labId, labId),
    ownerId === null ? undefined : or(eq(runs.startedBy, ownerId), eq(runs.example, true)),
  );

/** The input rule: the caller's upload, or an input an example run reads. */
export const readableInputs = ({ labId, ownerId }: Reader): SQL | undefined =>
  and(
    eq(inputs.labId, labId),
    ownerId === null
      ? undefined
      : or(
          eq(inputs.uploadedBy, ownerId),
          exists(
            sql`(SELECT 1 FROM ${runs} WHERE ${runs.inputId} = ${inputs.id} AND ${runs.example})`,
          ),
        ),
  );

type Row = { run: typeof runs.$inferSelect; input: typeof inputs.$inferSelect };

export const toInput = (row: typeof inputs.$inferSelect): Input => ({
  id: row.id,
  labId: row.labId,
  source: row.source,
  uploadedBy: row.uploadedBy,
  name: row.name,
});

function toRun({ run, input }: Row, position: number): Run {
  const iso = (d: Date | null) => d?.toISOString() ?? null;
  const startedAt = iso(run.startedAt);
  const state = ((): Run["state"] => {
    switch (run.state) {
      case "queued":
        return { status: "queued", position };
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
  return {
    id: run.id,
    labId: run.labId,
    startedBy: run.startedBy,
    workflows: run.workflows as WorkflowPin[],
    input: toInput(input),
    credentials: run.credentials,
    example: run.example,
    forkedFrom: run.forkedFrom,
    createdAt: run.createdAt.toISOString(),
    state,
  };
}

export async function countRuns(tx: Tx, where: SQL | undefined): Promise<number> {
  const [row] = await tx.select({ n: sql<number>`count(*)::int` }).from(runs).where(where);
  return row?.n ?? 0;
}

/** The run just written, which must exist. */
export async function loadRun(tx: Tx, runId: string): Promise<Run> {
  const [run] = await loadRuns(tx, eq(runs.id, runId));
  if (!run) throw new Error(`run ${runId} vanished inside its transaction`);
  return run;
}

/**
 * Runs matching `where`, newest first. A queued run's place is counted here, at read
 * time: the `voluma` runs of its org that queued before it. A visitor run waits only
 * for a runner, so its place is 1.
 */
export async function loadRuns(tx: Tx, where: SQL | undefined): Promise<Run[]> {
  const rows = await tx
    .select({ run: runs, input: inputs })
    .from(runs)
    .innerJoin(inputs, eq(runs.inputId, inputs.id))
    .where(where)
    .orderBy(desc(runs.createdAt), desc(runs.id));
  return Promise.all(
    rows.map(async (row) => {
      const { run } = row;
      if (run.state !== "queued" || run.credentials === "visitor") return toRun(row, 1);
      const ahead = await countRuns(
        tx,
        and(
          eq(runs.labId, run.labId),
          eq(runs.state, "queued"),
          eq(runs.credentials, "voluma"),
          or(
            lt(runs.createdAt, run.createdAt),
            and(eq(runs.createdAt, run.createdAt), lt(runs.id, run.id)),
          ),
        ),
      );
      return toRun(row, ahead + 1);
    }),
  );
}

/**
 * The write is the holder's: the token matches the run row and the run is running.
 * `FOR SHARE` keeps the claim's sweep from taking the run until this transaction ends,
 * so a late write can't land after a takeover.
 */
export async function assertLease(tx: Tx, runId: string, leaseToken: string) {
  const [row] = await tx
    .select({ id: runs.id })
    .from(runs)
    .where(and(eq(runs.id, runId), eq(runs.leaseToken, leaseToken), eq(runs.state, "running")))
    .for("share");
  if (!row) throw new LeaseLost();
}
