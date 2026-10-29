/**
 * Postgres adapter for the run queue: every state change of a run, and the key vault
 * (key-vault.ts) that goes with it. Each transition (start, resume, cancel, claim,
 * heartbeat, report) runs in one transaction under the queue lock, judged by the
 * database's `now()`; no API process's clock or memory decides a lease. The vault is only
 * touched under that lock, so holding or dropping a run's keys can't interleave with
 * the claim that hands them out: keys are held before the transaction that makes a run
 * queued commits, and dropped by whatever ends or moves it. The lease token stays on an
 * ended run so the old holder's next heartbeat is told to `stop`; a recovery clears it,
 * so that holder is `lease-lost` (lease.ts).
 */
import { randomBytes } from "node:crypto";
import type { Run, VisitorKeys } from "@voluma/contracts/run";
import {
  type ClaimEndReason,
  LEASE_SECONDS,
  type ReleaseReason,
  type Usage as RunnerUsage,
} from "@voluma/contracts/runner";
import type { WorkflowPin } from "@voluma/contracts/workflow";
import { heldUsdOfRun } from "@voluma/provider-calls";
import { and, asc, desc, eq, gt, inArray, notInArray, type SQL, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { Reader } from "../../domain";
import { admit, type Limits, type Refusal, refusalMessage, type Usage, usage } from "./admission";
import { endClaim, stalledError } from "./claim-progress";
import type { KeyVault } from "./key-vault";
import { LeaseLost } from "./lease";
import type { Notifier } from "./notifier";
import {
  loadRun,
  loadRuns,
  readableInputs,
  readableRuns,
  readableStudies,
  type Tx,
} from "./pg-runs";
import { events, inputs, runs, studies, studyScans } from "./schema";

/** Serializes every transaction that changes a run, so the limit counts can't race a claim. */
const QUEUE_LOCK = 0x76_6f_6c_71;

/** How long a visitor run waits for its keys. */
const KEYS_WAIT = sql`interval '24 hours'`;

const leaseUntil = sql`now() + make_interval(secs => ${LEASE_SECONDS})`;

/** A report on a run that already ended: the first end wins. */
export class RunEnded extends Error {
  constructor() {
    super("run has ended");
  }
}

export type RunnerReport =
  | { kind: "ended"; outcome: "completed" | "failed"; error?: string }
  | { kind: "released"; reason: ReleaseReason };

export type Claimed = {
  run: Run;
  leaseToken: string;
  /** The visitor run's keys, handed out once. */
  keys?: VisitorKeys;
  /** Present on every claim after the run's first. */
  previousClaim?: { reason: ClaimEndReason };
};

/**
 * Ends the matching running claims for `reason` and takes their runs back: a `voluma` run to
 * `queued`, a `visitor` run to `awaiting-keys` (its keys are gone). A claim that ended
 * without progress counts toward the no-progress limit (`claim-progress.ts`); at the limit
 * the run ends `failed`, naming the call that was in flight.
 */
async function recover(tx: Tx, where: SQL, reason: ClaimEndReason) {
  const held = await tx
    .select()
    .from(runs)
    .where(and(eq(runs.state, "running"), where))
    .for("update");
  for (const run of held) {
    const { stalledClaims, exhausted } = endClaim(run, reason);
    const base = {
      lastClaimEnd: reason,
      stalledClaims,
      leaseHolder: null,
      leaseToken: null,
      leaseExpiresAt: null,
    };
    if (exhausted) {
      await tx
        .update(runs)
        .set({
          ...base,
          state: "ended",
          outcome: "failed",
          endedAt: sql`now()`,
          error: stalledError(reason, await inFlightTool(tx, run.id, run.claimStartSeq)),
        })
        .where(eq(runs.id, run.id));
    } else {
      await tx
        .update(runs)
        .set({
          ...base,
          state: run.credentials === "visitor" ? "awaiting-keys" : "queued",
          awaitingSince: run.credentials === "visitor" ? sql`now()` : null,
        })
        .where(eq(runs.id, run.id));
    }
  }
}

/** The tool of the latest call this claim made that has no result: what the claim was cut off in. */
async function inFlightTool(tx: Tx, runId: string, sinceSeq: number): Promise<string | undefined> {
  const [row] = await tx
    .select({ name: sql<string>`${events.payload}->>'name'` })
    .from(events)
    .where(
      and(
        eq(events.runId, runId),
        eq(events.type, "tool.call"),
        gt(events.seq, sinceSeq),
        sql`NOT EXISTS (SELECT 1 FROM events r WHERE r.run_id = ${events.runId} AND r.type = 'tool.result' AND r.payload->>'toolCallId' = ${events.payload}->>'toolCallId')`,
      ),
    )
    .orderBy(desc(events.seq))
    .limit(1);
  return row?.name;
}

async function sweep(tx: Tx) {
  await recover(tx, sql`lease_expires_at <= now()`, "lease-expired");
  await tx.execute(sql`
    UPDATE runs SET state = 'ended', outcome = 'failed', ended_at = now(),
      error = 'The keys were not resent within 24 hours.'
    WHERE state = 'awaiting-keys' AND awaiting_since <= now() - ${KEYS_WAIT}`);
}

const fail = (tx: Tx, runId: string, error: string) =>
  tx
    .update(runs)
    .set({ state: "ended", outcome: "failed", endedAt: sql`now()`, error })
    .where(eq(runs.id, runId));

const NO_LIMITS = "This organization can no longer run work.";

/** One run of a start call. `keys` present: a visitor run. */
type RunRequest = {
  id: string;
  inputId: string;
  selectedOutputs?: string[];
  notes?: string;
  keys?: VisitorKeys;
};

export type StartRefusal =
  | Refusal
  | "no-input"
  | "input-not-ready"
  | "full"
  | "no-study"
  | "no-workflow"
  | "example";

/** Thrown inside a start's transaction to roll it back whole. */
class Refused extends Error {
  constructor(readonly reason: StartRefusal) {
    super(reason);
  }
}

/**
 * `limits` has every org the API serves (index.ts). An org missing from it is one no
 * longer configured: its queued runs fail and its running ones stop.
 */
export function pgRunQueue(
  db: PostgresJsDatabase,
  limits: ReadonlyMap<string, Limits>,
  vault: KeyVault,
  notifier: Notifier,
) {
  const locked = <T>(work: (tx: Tx) => Promise<T>) =>
    db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${QUEUE_LOCK})`);
      return work(tx);
    });

  /** Browser calls only: a signed-in user's or guest's org is always configured (auth.ts). */
  const limitsOf = (labId: string): Limits => {
    const found = limits.get(labId);
    if (!found) throw new Error(`organization ${labId} has no run limits`);
    return found;
  };

  /** Runs a start under the lock; a `Refused` rolls it back, and any failure forgets the keys it held. */
  const attempt = async <T>(
    runIds: string[],
    work: (tx: Tx) => Promise<T>,
  ): Promise<T | { refused: StartRefusal }> => {
    try {
      return await locked(work);
    } catch (error) {
      for (const id of runIds) vault.drop(id);
      if (error instanceof Refused) return { refused: error.reason };
      throw error;
    }
  };

  /** Every input must be readable; an uncompleted upload exists only for its uploader. Returns them by id. */
  const checkInputs = async (tx: Tx, reader: Reader, caller: { userId: string }, ids: string[]) => {
    const found = await tx
      .select({
        id: inputs.id,
        name: inputs.name,
        status: inputs.status,
        uploadedBy: inputs.uploadedBy,
      })
      .from(inputs)
      .where(and(readableInputs(reader), inArray(inputs.id, ids)));
    const byId = new Map(found.map((input) => [input.id, input]));
    for (const id of ids) {
      const input = byId.get(id);
      if (!input || (input.status !== "ready" && input.uploadedBy !== caller.userId)) {
        throw new Refused("no-input");
      }
    }
    if (found.some((input) => input.status !== "ready")) throw new Refused("input-not-ready");
    return byId;
  };

  /** Admits one run against the limits (counting the runs this transaction already inserted) and inserts it `queued`. */
  const startOne = async (
    tx: Tx,
    reader: Reader,
    caller: { userId: string },
    study: { id: string; workflowId: string; pins: WorkflowPin[] },
    request: RunRequest,
  ) => {
    const credentials = request.keys ? "visitor" : "voluma";
    const refused = admit(
      "start",
      limitsOf(reader.labId),
      await usage(tx, reader.labId, { userId: caller.userId, credentials }),
      { credentials },
    );
    if (refused) throw new Refused(refused);
    if (request.keys && !vault.hold(request.id, reader.labId, request.keys)) {
      throw new Refused("full");
    }
    await tx.insert(runs).values({
      id: request.id,
      labId: reader.labId,
      startedBy: caller.userId,
      studyId: study.id,
      workflowId: study.workflowId,
      workflows: study.pins,
      selectedOutputs: request.selectedOutputs ?? null,
      notes: request.notes ?? null,
      inputId: request.inputId,
      credentials,
      state: "queued",
    });
  };

  return {
    /**
     * Creates one run `queued` on a scan of an existing study. Refuses a study the reader
     * can't read (or the example's), a scan the study lacks, an input still uploading, a
     * limit already reached, and a visitor run when the vault is full.
     */
    start: (
      reader: Reader,
      caller: { userId: string },
      request: RunRequest & {
        studyId: string;
        /** The pins of a catalog workflow; the study says which. */
        pinsOf: (workflowId: string) => WorkflowPin[] | undefined;
      },
    ) =>
      attempt([request.id], async (tx) => {
        const [study] = await tx
          .select({ workflowId: studies.workflowId, example: studies.example })
          .from(studies)
          .where(and(readableStudies(reader), eq(studies.id, request.studyId)));
        if (!study) throw new Refused("no-study");
        if (study.example) throw new Refused("example");
        const [scan] = await tx
          .select({ inputId: studyScans.inputId })
          .from(studyScans)
          .where(
            and(eq(studyScans.studyId, request.studyId), eq(studyScans.inputId, request.inputId)),
          );
        if (!scan) throw new Refused("no-input");
        const pins = request.pinsOf(study.workflowId);
        if (!pins) throw new Refused("no-workflow");
        await checkInputs(tx, reader, caller, [request.inputId]);
        await startOne(
          tx,
          reader,
          caller,
          { id: request.studyId, workflowId: study.workflowId, pins },
          request,
        );
        return { run: await loadRun(tx, request.id) };
      }),

    /**
     * Creates a study, its scans and a `queued` run for each of `runs`, in one transaction:
     * any refusal (an input, a limit, the vault) refuses the whole call and leaves nothing.
     * Returns the study's id.
     */
    createStudy: (
      reader: Reader,
      caller: { userId: string },
      request: {
        study: Omit<typeof studies.$inferInsert, "labId" | "createdBy" | "example" | "createdAt">;
        pins: WorkflowPin[];
        /** `subject` absent: the input's name. */
        scans: (Omit<typeof studyScans.$inferInsert, "studyId" | "position" | "subject"> & {
          subject?: string;
        })[];
        /** The runs to start now, one per scan to start. */
        runs: (RunRequest & { inputId: string })[];
      },
    ) =>
      attempt(
        request.runs.map(({ id }) => id),
        async (tx) => {
          const found = await checkInputs(
            tx,
            reader,
            caller,
            request.scans.map((scan) => scan.inputId),
          );
          await tx.insert(studies).values({
            ...request.study,
            labId: reader.labId,
            createdBy: caller.userId,
          });
          await tx.insert(studyScans).values(
            request.scans.map((scan, position) => ({
              ...scan,
              subject: scan.subject ?? (found.get(scan.inputId)?.name as string),
              studyId: request.study.id,
              position,
            })),
          );
          const study = {
            id: request.study.id,
            workflowId: request.study.workflowId,
            pins: request.pins,
          };
          for (const run of request.runs) await startOne(tx, reader, caller, study, run);
          return { studyId: request.study.id };
        },
      ),

    /** Ends the run `cancelled` at once and forgets its keys. Example runs are read-only. */
    async cancel(reader: Reader, runId: string) {
      const result = await locked(async (tx) => {
        const [run] = await loadRuns(tx, and(readableRuns(reader), eq(runs.id, runId)));
        if (!run) return "not-found" as const;
        if (run.example) return "example" as const;
        vault.drop(runId);
        if (run.state.status === "ended") return run;
        await tx
          .update(runs)
          .set({ state: "ended", outcome: "cancelled", endedAt: sql`now()` })
          .where(eq(runs.id, runId));
        return loadRun(tx, runId);
      });
      notifier.notify(runId);
      return result;
    },

    /**
     * `awaiting-keys` → `queued`, for the run's own starter, holding the new keys. The run
     * stays as it was when the visitor cap is reached or the vault is full.
     */
    async resume(reader: Reader, userId: string, runId: string, keys: VisitorKeys) {
      try {
        return await locked(async (tx) => {
          const [run] = await loadRuns(tx, and(readableRuns(reader), eq(runs.id, runId)));
          if (!run) return "not-found" as const;
          if (run.startedBy !== userId) return "forbidden" as const;
          if (run.state.status !== "awaiting-keys") return "conflict" as const;
          const refused = admit(
            "resume",
            limitsOf(reader.labId),
            await usage(tx, reader.labId),
            run,
          );
          if (refused) return refused;
          if (!vault.hold(runId, reader.labId, keys)) return "full" as const;
          await tx
            .update(runs)
            .set({ state: "queued", awaitingSince: null })
            .where(eq(runs.id, runId));
          return loadRun(tx, runId);
        });
      } catch (error) {
        vault.drop(runId);
        throw error;
      }
    },

    /**
     * One transaction: sweep expired leases, send the queued visitor runs whose keys this
     * process doesn't hold (another process took the start, or it restarted) to
     * `awaiting-keys`, then take the oldest queued run of the org served longest ago
     * that the limits allow, with its keys if it is a visitor run. The held ids are read
     * under the lock: a start that holds its keys before it commits is either in them or
     * not yet queued.
     */
    claim: (runnerId: string, costCapUsd?: number) =>
      locked(async (tx): Promise<Claimed | null> => {
        await sweep(tx);
        await tx
          .update(runs)
          .set({ state: "awaiting-keys", awaitingSince: sql`now()` })
          .where(
            and(
              eq(runs.state, "queued"),
              eq(runs.credentials, "visitor"),
              notInArray(runs.id, vault.ids()),
            ),
          );
        // Round-robin by org: the org claimed longest ago goes first (never claimed: first),
        // and within an org the oldest run, so one org's backlog can't starve another.
        const queued = await tx
          .select()
          .from(runs)
          .where(eq(runs.state, "queued"))
          .orderBy(
            sql`(SELECT max(o.claimed_at) FROM runs o WHERE o.lab_id = ${runs.labId}) ASC NULLS FIRST`,
            asc(runs.createdAt),
            asc(runs.id),
          );
        // Failing or skipping a run changes none of these counts, so read each org's once.
        const usages = new Map<string, Usage>();
        for (const run of queued) {
          const orgLimits = limits.get(run.labId);
          if (!orgLimits) {
            await fail(tx, run.id, NO_LIMITS);
            vault.drop(run.id);
            continue;
          }
          if (run.credentials === "voluma") {
            const used = usages.get(run.labId) ?? (await usage(tx, run.labId));
            usages.set(run.labId, used);
            const refused = admit("claim", orgLimits, used, {
              credentials: "voluma",
              firstClaim: run.startedAt === null,
            });
            if (refused === "concurrent") continue;
            if (refused) {
              await fail(tx, run.id, refusalMessage[refused]);
              continue;
            }
          }
          const leaseToken = randomBytes(24).toString("hex");
          await tx
            .update(runs)
            .set({
              state: "running",
              startedAt: sql`coalesce(${runs.startedAt}, now())`,
              claimedAt: sql`now()`,
              claimStartSeq: sql`coalesce((SELECT max(seq) FROM events WHERE run_id = ${run.id}), 0)`,
              leaseHolder: runnerId,
              leaseToken,
              leaseExpiresAt: leaseUntil,
              costCapUsd: costCapUsd ?? null,
            })
            .where(eq(runs.id, run.id));
          const keys = run.credentials === "visitor" ? vault.take(run.id) : undefined;
          return {
            run: await loadRun(tx, run.id),
            leaseToken,
            ...(keys && { keys }),
            ...(run.lastClaimEnd && { previousClaim: { reason: run.lastClaimEnd } }),
          };
        }
        return null;
      }),

    /**
     * Extends the lease and adds the usage; `stop` once the run has ended. `spentUsd` is the
     * run's settled spend: its model cost plus its finished provider calls (open ones count nothing). Throws `LeaseLost`.
     */
    heartbeat: (runId: string, leaseToken: string, used: RunnerUsage) =>
      locked(async (tx) => {
        const [run] = await tx
          .select()
          .from(runs)
          .where(and(eq(runs.id, runId), eq(runs.leaseToken, leaseToken)))
          .for("update");
        if (!run) throw new LeaseLost();
        if (run.state !== "running") return { stop: true };
        const orgLimits = limits.get(run.labId);
        if (!orgLimits) {
          await fail(tx, runId, NO_LIMITS);
          return { stop: true };
        }
        await tx
          .update(runs)
          .set({
            leaseExpiresAt: leaseUntil,
            modelCostUsd: sql`${runs.modelCostUsd} + ${used.modelCostUsd}`,
            sandboxSeconds: sql`${runs.sandboxSeconds} + ${used.sandboxSeconds}`,
          })
          .where(eq(runs.id, runId));
        if (run.credentials === "voluma") {
          const refused = admit("heartbeat", orgLimits, await usage(tx, run.labId), run);
          if (refused) {
            await fail(tx, runId, refusalMessage[refused]);
            return { stop: true };
          }
        }
        const gateway = await heldUsdOfRun(tx, runId);
        return { stop: false, spentUsd: run.modelCostUsd + used.modelCostUsd + gateway };
      }),

    /** Throws `LeaseLost` or `RunEnded`. */
    async report(runId: string, leaseToken: string, report: RunnerReport) {
      await locked(async (tx) => {
        const [run] = await tx
          .select({ state: runs.state })
          .from(runs)
          .where(and(eq(runs.id, runId), eq(runs.leaseToken, leaseToken)))
          .for("update");
        if (!run) throw new LeaseLost();
        if (run.state !== "running") throw new RunEnded();
        if (report.kind === "released") {
          await recover(tx, sql`id = ${runId}`, report.reason);
          return;
        }
        await tx
          .update(runs)
          .set({
            state: "ended",
            outcome: report.outcome,
            endedAt: sql`now()`,
            error: report.error ?? null,
          })
          .where(eq(runs.id, runId));
      });
      notifier.notify(runId);
    },
  };
}

export type RunQueue = ReturnType<typeof pgRunQueue>;
