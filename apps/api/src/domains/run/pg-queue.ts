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
import type { PersonMessage } from "@voluma/contracts/messages";
import type { Run, VisitorKeys } from "@voluma/contracts/run";
import {
  type ClaimEndReason,
  LEASE_SECONDS,
  type ReleaseReason,
  type Usage as RunnerUsage,
} from "@voluma/contracts/runner";
import type { WorkflowPin } from "@voluma/contracts/workflow";
import { type OutputEntry, unselectable } from "@voluma/contracts/workflow-files";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  lte,
  notInArray,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { Caller, Reader } from "../../domain";
import { admit, type Limits, type Refusal, refusalMessage, type Usage, usage } from "./admission";
import { endClaim, outageDelayMinutes, stalledError } from "./claim-progress";
import { decideMessage, endCorrection, openCorrection } from "./corrections";
import type { KeyVault } from "./key-vault";
import { LeaseLost, noLease } from "./lease";
import type { Notifier } from "./notifier";
import { cancelOpenThreads, eventLock } from "./pg-event-log";
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
  const ids = await tx
    .select({ id: runs.id })
    .from(runs)
    .where(and(eq(runs.state, "running"), where));
  for (const { id } of ids) {
    await eventLock(tx, id); // before the row lock (`corrections.ts`)
    const [run] = await tx.select().from(runs).where(eq(runs.id, id)).for("update");
    if (!run) continue;
    const { stalledClaims, exhausted } = endClaim(run, reason);
    const base = {
      lastClaimEnd: reason,
      stalledClaims,
      ...noLease,
    };
    // A visitor run waits for its keys, not for a time.
    const holdBack =
      reason === "provider-outage" && run.credentials === "voluma"
        ? sql`now() + make_interval(mins => ${outageDelayMinutes(stalledClaims)})`
        : null;
    if (exhausted) {
      await endUnfinished(
        tx,
        run.id,
        "failed",
        stalledError(reason, await inFlightTool(tx, run.id, run.claimStartSeq)),
        base,
      );
    } else {
      await tx
        .update(runs)
        .set({
          ...base,
          state: run.credentials === "visitor" ? "awaiting-keys" : "queued",
          awaitingSince: run.credentials === "visitor" ? sql`now()` : null,
          claimableAfter: holdBack,
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

const fail = (tx: Tx, runId: string, error: string) => endUnfinished(tx, runId, "failed", error);

/**
 * Ends a run that did not finish, `failed` or `cancelled`. A run in a correction (reopened by a
 * person's message, `messages.ts`) is never left worse than `completed`: its open threads end
 * `cancelled`, `correction.ended` records what happened, and the run ends `completed` with its
 * earlier results. `set` adds columns to the update (a recovery's lease reset).
 */
async function endUnfinished(
  tx: Tx,
  runId: string,
  status: "failed" | "cancelled",
  error?: string,
  set: Partial<typeof runs.$inferInsert> = {},
) {
  const reopenId = await openCorrection(tx, runId);
  const correcting = reopenId !== null;
  if (status === "cancelled" || correcting) await cancelOpenThreads(tx, runId);
  if (correcting) await endCorrection(tx, runId, reopenId, status, error);
  await tx
    .update(runs)
    .set({
      ...set,
      state: "ended",
      outcome: correcting ? "completed" : status,
      endedAt: sql`now()`,
      claimableAfter: null,
      error: correcting ? null : (error ?? null),
    })
    .where(eq(runs.id, runId));
}

const NO_LIMITS = "This organization can no longer run work.";

/** What the runs of one start call share: the credentials kind comes from `keys`. */
type Starts = {
  runs: { id: string; inputId: string }[];
  selectedOutputs?: string[];
  notes?: string;
  keys?: VisitorKeys;
};

/** Why a write was refused; `Refusal` is a limit. */
export type QueueRefusal =
  | Refusal
  | "guest-keys"
  | "no-input"
  | "input-not-ready"
  | "full"
  | "no-study"
  | "no-workflow"
  | "bad-selection"
  | "example"
  | "not-found"
  | "forbidden"
  | "conflict";

/** Thrown inside a write's transaction to roll it back whole. */
class Refused extends Error {
  /** `detail`: what the answer names (the ids of a bad selection). */
  constructor(
    readonly reason: QueueRefusal,
    readonly detail?: string[],
  ) {
    super(reason);
  }
}

/**
 * `limits` has every org the API serves (index.ts). An org missing from it is one no
 * longer configured: its queued runs fail and its running ones stop. `workflowOf` resolves a
 * study's workflow id to the pins its runs record and the outputs a selection is checked against.
 */
export function pgRunQueue(
  db: PostgresJsDatabase,
  limits: ReadonlyMap<string, Limits>,
  vault: KeyVault,
  notifier: Notifier,
  workflowOf: (workflowId: string) => { pins: WorkflowPin[]; outputs: OutputEntry[] } | undefined,
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

  type Hold = (runId: string, labId: string, keys: VisitorKeys) => boolean;

  /**
   * Runs a write of the browser under the lock. A `Refused` rolls it back and is the answer,
   * `{ refused }`; any failure forgets the keys the work held through `hold`.
   */
  const attempt = async <T>(
    work: (tx: Tx, hold: Hold) => Promise<T>,
  ): Promise<T | { refused: QueueRefusal; detail?: string[] }> => {
    const held: string[] = [];
    const hold: Hold = (runId, labId, keys) => {
      const ok = vault.hold(runId, labId, keys);
      if (ok) held.push(runId);
      return ok;
    };
    try {
      return await locked((tx) => work(tx, hold));
    } catch (error) {
      for (const id of held) vault.drop(id);
      if (error instanceof Refused) return { refused: error.reason, detail: error.detail };
      throw error;
    }
  };

  const messageContext = (reader: Reader) => ({
    limits: limitsOf(reader.labId),
    pinsOf: (workflowId: string) => workflowOf(workflowId)?.pins,
  });

  const workflowFor = (workflowId: string) => {
    const workflow = workflowOf(workflowId);
    if (!workflow) throw new Refused("no-workflow");
    return workflow;
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

  /**
   * Admits each of `starts.runs` against the limits and inserts it `queued`. The counts are
   * read once, then raised by each run inserted, so the last run is judged with the others.
   */
  const startRuns = async (
    tx: Tx,
    hold: Hold,
    reader: Reader,
    caller: Caller,
    study: { id: string },
    workflow: { pins: WorkflowPin[]; outputs: OutputEntry[] },
    starts: Starts,
  ) => {
    const bad = unselectable(workflow.outputs, starts.selectedOutputs ?? []);
    if (bad.length) throw new Refused("bad-selection", bad);
    if (starts.runs.length === 0) return;
    // A guest runs only on their own keys: Voluma's are for signed-in accounts.
    if (caller.guest && !starts.keys) throw new Refused("guest-keys");
    const credentials = starts.keys ? "visitor" : "voluma";
    const used = await usage(tx, reader.labId, { userId: caller.userId, credentials });
    for (const { id, inputId } of starts.runs) {
      const refused = admit("start", limitsOf(reader.labId), used, { credentials });
      if (refused) throw new Refused(refused);
      if (starts.keys && !hold(id, reader.labId, starts.keys)) throw new Refused("full");
      await tx.insert(runs).values({
        id,
        labId: reader.labId,
        startedBy: caller.userId,
        studyId: study.id,
        workflows: workflow.pins,
        selectedOutputs: starts.selectedOutputs ?? null,
        notes: starts.notes ?? null,
        inputId,
        credentials,
        state: "queued",
      });
      used.callerUnfinished++;
      if (credentials === "visitor") used.visitorActive++;
    }
  };

  return {
    /**
     * Creates one run `queued` on a scan of an existing study. Refuses a study the reader
     * can't read (or the example's), a scan the study lacks, an input still uploading, a
     * limit already reached, and a visitor run when the vault is full.
     */
    start: (
      reader: Reader,
      caller: Caller,
      request: Omit<Starts, "runs"> & { id: string; studyId: string; inputId: string },
    ) =>
      attempt(async (tx, hold) => {
        const [study] = await tx
          .select({ id: studies.id, workflowId: studies.workflowId, example: studies.example })
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
        await checkInputs(tx, reader, caller, [request.inputId]);
        await startRuns(tx, hold, reader, caller, study, workflowFor(study.workflowId), {
          ...request,
          runs: [{ id: request.id, inputId: request.inputId }],
        });
        return { run: await loadRun(tx, request.id) };
      }),

    /**
     * Creates a study, its scans and a `queued` run for each of `starts.runs`, in one
     * transaction: any refusal (an input, a limit, the vault) refuses the whole call and
     * leaves nothing. Returns the study's id.
     */
    createStudy: (
      reader: Reader,
      caller: Caller,
      request: {
        study: Omit<typeof studies.$inferInsert, "labId" | "createdBy" | "example" | "createdAt">;
        /** `subject` absent: the input's name. */
        scans: (Omit<typeof studyScans.$inferInsert, "studyId" | "position" | "subject"> & {
          subject?: string;
        })[];
        /** The runs to start now, one per scan to start. */
        starts: Starts;
      },
    ) =>
      attempt(async (tx, hold) => {
        const workflow = workflowFor(request.study.workflowId);
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
            subject: scan.subject ?? found.get(scan.inputId)!.name,
            studyId: request.study.id,
            position,
          })),
        );
        await startRuns(tx, hold, reader, caller, request.study, workflow, request.starts);
        return { studyId: request.study.id };
      }),

    /**
     * Ends the run `cancelled` at once and forgets its keys; a run in a correction ends
     * `completed` with the cancel recorded (`endUnfinished`). Example runs are read-only.
     */
    async cancel(reader: Reader, runId: string) {
      const result = await attempt(async (tx) => {
        const [run] = await loadRuns(tx, and(readableRuns(reader), eq(runs.id, runId)));
        if (!run) throw new Refused("not-found");
        if (run.example) throw new Refused("example");
        vault.drop(runId);
        if (run.state.status === "ended") return { run };
        await endUnfinished(tx, runId, "cancelled");
        return { run: await loadRun(tx, runId) };
      });
      notifier.notify(runId);
      return result;
    },

    /** Whether `reader` may send this message now, without storing anything (`decideMessage`). */
    checkMessage: (
      reader: Reader,
      caller: { userId: string; guest: boolean },
      runId: string,
      msg: { id: string; payload: PersonMessage },
    ) =>
      db.transaction((tx) =>
        decideMessage(tx, messageContext(reader), reader, caller, runId, msg, false),
      ),

    /** Stores the message, reopening the run if it had ended; one transaction under the queue lock. */
    async sendMessage(
      reader: Reader,
      caller: { userId: string; guest: boolean },
      runId: string,
      msg: { id: string; payload: PersonMessage },
    ) {
      const result = await locked((tx) =>
        decideMessage(tx, messageContext(reader), reader, caller, runId, msg, true),
      );
      if ("ok" in result && !result.ok.duplicate) notifier.notify(runId);
      return result;
    },

    /**
     * `awaiting-keys` → `queued`, for the run's own starter, holding the new keys. The run
     * stays as it was when the visitor cap is reached or the vault is full.
     */
    resume: (reader: Reader, userId: string, runId: string, keys: VisitorKeys) =>
      attempt(async (tx, hold) => {
        const [run] = await loadRuns(tx, and(readableRuns(reader), eq(runs.id, runId)));
        if (!run) throw new Refused("not-found");
        if (run.startedBy !== userId) throw new Refused("forbidden");
        if (run.state.status !== "awaiting-keys") throw new Refused("conflict");
        const refused = admit("resume", limitsOf(reader.labId), await usage(tx, reader.labId), run);
        if (refused) throw new Refused(refused);
        if (!hold(runId, reader.labId, keys)) throw new Refused("full");
        await tx
          .update(runs)
          .set({ state: "queued", awaitingSince: null })
          .where(eq(runs.id, runId));
        return { run: await loadRun(tx, runId) };
      }),

    /**
     * One transaction: sweep expired leases, send the queued visitor runs whose keys this
     * process doesn't hold (another process took the start, or it restarted) to
     * `awaiting-keys`, then take the oldest queued run of the org served longest ago
     * that the limits allow, with its keys if it is a visitor run. The held ids are read
     * under the lock: a start that holds its keys before it commits is either in them or
     * not yet queued.
     */
    claim: (runnerId: string) =>
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
          .where(
            and(
              eq(runs.state, "queued"),
              or(isNull(runs.claimableAfter), lte(runs.claimableAfter, sql`now()`)),
            ),
          )
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
            const refused = admit("claim", orgLimits, used, { credentials: "voluma" });
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
              claimableAfter: null,
              claimStartSeq: sql`coalesce((SELECT max(seq) FROM events WHERE run_id = ${run.id}), 0)`,
              leaseHolder: runnerId,
              leaseToken,
              leaseExpiresAt: leaseUntil,
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
     * Extends the lease and adds the usage; `stop` once the run has ended. Throws `LeaseLost`.
     */
    heartbeat: (runId: string, leaseToken: string, used: RunnerUsage) =>
      locked(async (tx) => {
        await eventLock(tx, runId); // a failing heartbeat ends the run's threads (`corrections.ts`)
        const [run] = await tx
          .select()
          .from(runs)
          .where(and(eq(runs.id, runId), eq(runs.leaseToken, leaseToken)))
          .for("update");
        if (!run) throw new LeaseLost();
        if (run.state !== "running") return { stop: true };
        // An org dropped from config stops its running runs here (its queued ones fail at claim).
        if (!limits.has(run.labId)) {
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
        return { stop: false };
      }),

    /**
     * Throws `LeaseLost` or `RunEnded`. A failed claim of a reopened run ends it `completed`
     * (`endUnfinished`).
     */
    async report(runId: string, leaseToken: string, report: RunnerReport) {
      await locked(async (tx) => {
        await eventLock(tx, runId); // before the row lock: `endUnfinished` appends events
        const [run] = await tx
          .select({ state: runs.state })
          .from(runs)
          .where(and(eq(runs.id, runId), eq(runs.leaseToken, leaseToken)))
          .for("update");
        if (!run) throw new LeaseLost();
        if (run.state !== "running") throw new RunEnded();
        if (report.kind === "released") {
          await recover(tx, sql`id = ${runId}`, report.reason);
        } else if (report.outcome === "failed") {
          await endUnfinished(tx, runId, "failed", report.error);
        } else {
          await tx
            .update(runs)
            .set({ state: "ended", outcome: "completed", endedAt: sql`now()`, error: null })
            .where(eq(runs.id, runId));
        }
      });
      notifier.notify(runId);
    },
  };
}

export type RunQueue = ReturnType<typeof pgRunQueue>;
