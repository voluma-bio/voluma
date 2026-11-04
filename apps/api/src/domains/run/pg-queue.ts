/**
 * Postgres adapter for the run queue: every state change of a run, and the key vault
 * (key-vault.ts) that goes with it. Each transition (start, resume, cancel, claim,
 * heartbeat, report) runs in one transaction, judged by the database's `now()`; no API
 * process's clock or memory decides a lease. Which transitions take the queue lock, and why
 * heartbeat and report don't: `apps/api/AGENTS.md`. The vault is only touched under that lock, so holding or dropping a run's keys can't interleave with
 * the claim that hands them out: keys are held before the transaction that makes a run
 * queued commits, and dropped by whatever ends or moves it. The lease token stays on an
 * ended run so the old holder's next heartbeat is told to `stop`; a recovery clears it,
 * so that holder is `lease-lost` (lease.ts).
 */
import { randomBytes } from "node:crypto";
import type { Harness } from "@voluma/contracts/ids";
import type { AnswerApprovalRequest, PersonMessage } from "@voluma/contracts/messages";
import type { Run, RunThinking, VisitorKeys } from "@voluma/contracts/run";
import {
  LEASE_SECONDS,
  type ReleaseReason,
  type Usage as RunnerUsage,
} from "@voluma/contracts/runner";
import type { WorkflowPin } from "@voluma/contracts/workflow";
import { type OutputEntry, unselectable } from "@voluma/contracts/workflow-files";
import { and, asc, desc, eq, gt, inArray, notInArray, type SQL, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { HTTPException } from "hono/http-exception";
import type { Caller, Reader } from "../../domain";
import {
  admit,
  type Limits,
  type Refusal,
  refusalError,
  refusalMessage,
  type Usage,
  usage,
} from "./admission";
import { lateResearcherWrite } from "./agent-review";
import { type ClaimEnd, endClaim, isCounted, stalledError } from "./claim-progress";
import {
  answerApproval,
  decideMessage,
  endCorrection,
  GUEST_KEYS_MESSAGE,
  messageRefusal,
  messageTargetOf,
  openCorrection,
  reopen,
} from "./corrections";
import type { KeyVault } from "./key-vault";
import { LeaseLost, noLease } from "./lease";
import type { Notifier } from "./notifier";
import { cancelOpenThreads, cancelReviewWorkers, lockRun } from "./pg-event-log";
import {
  loadRun,
  loadRuns,
  ownKeyBusy,
  type Queryable,
  queueOrder,
  readableInputs,
  readableRuns,
  readableStudies,
  type Tx,
} from "./pg-runs";
import { DEFAULT_THINKING, modelChoices, pickModel } from "./run-models";
import { events, inputs, runs, studies, studyMembers } from "./schema";

/**
 * Serializes the transactions that admit or start work: claim, start, resume, cancel, message,
 * import/archive. A heartbeat and a report take only the run's own locks (`lockRun`: event lock, then the
 * row), so a slow claim never delays an acknowledgement. They can skip this lock because they
 * only take a run off `running`, which lowers the counts a claim reads (`usage`); the one write
 * that raises them, `queued` → `running`, is the claim's, under this lock.
 */
export const QUEUE_LOCK = 0x76_6f_6c_71;

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
  | { kind: "ended"; outcome: "completed" | "failed"; error?: string; readSeq?: number }
  | { kind: "released"; reason: ReleaseReason };

export type Claimed = {
  run: Run;
  leaseToken: string;
  /** The visitor run's keys, handed out once. */
  keys?: VisitorKeys;
  /** The study's budget (`claimSchema.budgetUsd`); null: none. */
  budgetUsd: number | null;
  /** Present on every claim after the run's first. */
  previousClaim?: { reason: NonNullable<(typeof runs.$inferSelect)["lastClaimEnd"]> };
};

/**
 * Ends the matching running claims for `reason` and takes their runs back: a `voluma` run to
 * `queued`, a `visitor` run to `awaiting-keys` (its keys are gone). A claim that ended
 * without progress counts toward the no-progress limit (`claim-progress.ts`); at the limit
 * the run ends `failed`, naming the call that was in flight.
 */
async function recover(tx: Tx, where: SQL, reason: ClaimEnd) {
  const ids = await tx
    .select({ id: runs.id })
    .from(runs)
    .where(and(eq(runs.state, "running"), where));
  for (const { id } of ids) {
    // The lock wait may have let a heartbeat extend the lease or a report end the claim: judge
    // the row again as it is now.
    const run = await lockRun(tx, id, and(eq(runs.state, "running"), where));
    if (!run) continue;
    const { stalledClaims, exhausted, counted } = endClaim(run, reason);
    const base = {
      lastClaimEnd: reason,
      stalledClaims,
      struckLeaseToken: reason === "lease-expired" && counted ? run.leaseToken : null,
      ...noLease,
    };
    if (exhausted) {
      await endUnfinished(
        tx,
        run.id,
        "failed",
        stalledError(await inFlightTool(tx, run.id, run.claimStartSeq)),
        base,
      );
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

/**
 * The tool of the latest call this claim made that has no result: what the claim was cut off in.
 * Matches in JS over the raw payloads: a json operator would error on a `tool.result` output
 * holding `\u0000`, and this runs inside claim.
 */
async function inFlightTool(tx: Tx, runId: string, sinceSeq: number): Promise<string | undefined> {
  const rows = await tx
    .select({ type: events.type, payload: events.payload })
    .from(events)
    .where(
      and(
        eq(events.runId, runId),
        inArray(events.type, ["tool.call", "tool.result"]),
        gt(events.seq, sinceSeq),
      ),
    )
    .orderBy(desc(events.seq));
  const idOf = (payload: unknown) => (payload as { toolCallId?: unknown } | null)?.toolCallId;
  const answered = new Set(
    rows.filter((r) => r.type === "tool.result").map((r) => idOf(r.payload)),
  );
  const open = rows.find((r) => r.type === "tool.call" && !answered.has(idOf(r.payload)));
  return (open?.payload as { name?: string } | undefined)?.name;
}

/**
 * A `released` report from a lease the API already swept and counted: the runner was alive and
 * only the outage kept the report back. Records the reported end and takes the strike back.
 * False when the token is not that of a counted sweep (or the sweep failed the run).
 */
async function takeBackStrike(tx: Tx, runId: string, leaseToken: string, reason: ReleaseReason) {
  const run = await lockRun(tx, runId, eq(runs.struckLeaseToken, leaseToken));
  // A counted reason keeps its strike; an ended run (the sweep failed it) stays ended.
  if (!run || run.state === "ended" || isCounted(reason)) return false;
  await tx
    .update(runs)
    .set({
      lastClaimEnd: reason,
      stalledClaims: sql`greatest(${runs.stalledClaims} - 1, 0)`,
      struckLeaseToken: null,
    })
    .where(eq(runs.id, runId));
  return true;
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
 * earlier results. On the agent loop only the workers and the root end, and main stays cut off
 * (`cancelReviewWorkers`). `set` adds columns to the update (a recovery's lease reset).
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
  const [{ harness } = { harness: null }] = correcting
    ? await tx.select({ harness: runs.harness }).from(runs).where(eq(runs.id, runId))
    : [];
  if (correcting && harness === "agents") {
    // Review on the agent loop (`cancelReviewWorkers`): main is cut off, not ended, and no correction span exists.
    await cancelReviewWorkers(tx, runId, status === "cancelled");
  } else {
    if (status === "cancelled" || correcting) await cancelOpenThreads(tx, runId);
    if (correcting) await endCorrection(tx, runId, reopenId, status, error);
  }
  await tx
    .update(runs)
    .set({
      ...set,
      state: "ended",
      outcome: correcting ? "completed" : status,
      endedAt: sql`now()`,
      error: correcting ? null : (error ?? null),
    })
    .where(eq(runs.id, runId));
}

/**
 * The first researcher write the ending claim never saw (`lateResearcherWrite`), from raw columns:
 * the payload is read only of `thread.started`, in JS, as a json operator would fail on `\u0000`.
 */
async function lateWrite(tx: Tx, runId: string, readSeq: number | undefined) {
  const rows = await tx
    .select({
      id: events.id,
      type: events.type,
      seq: events.seq,
      threadId: events.threadId,
      payload: sql<unknown>`CASE WHEN ${events.type} = 'thread.started' THEN ${events.payload} END`,
    })
    .from(events)
    .where(
      and(
        eq(events.runId, runId),
        inArray(events.type, [
          "thread.started",
          "thread.ended",
          "run.reopened",
          "person.message",
          "approval.given",
          "approval.declined",
        ]),
      ),
    )
    .orderBy(asc(events.seq));
  return lateResearcherWrite(rows, readSeq);
}

/** What the runs of one start call share: the credentials kind comes from `keys`. */
type Starts = {
  runs: { id: string; inputId: string }[];
  selectedOutputs?: string[];
  notes?: string;
  keys?: VisitorKeys;
  /** The model the caller asked for; `pickModel` decides the run's. */
  model?: string;
  /** The thinking level the caller asked for; absent: `DEFAULT_THINKING`. */
  thinking?: RunThinking;
  /** The loop the caller asked for; absent: `defaultHarness`. */
  harness?: Harness;
};

/** A limit reached is 429; an account without a key is 403. */
const limitRefusal = (refused: Refusal) =>
  new HTTPException(refused === "no-key" ? 403 : 429, { message: refusalMessage[refused] });

/**
 * `limits.voluma` has every org that may run on Voluma's keys (index.ts). A `voluma` run of an org
 * missing from it (no longer configured) fails if queued and stops if running. `workflowOf` resolves a
 * study's workflow id to the pins its runs record and the outputs a selection is checked against.
 */
export function pgRunQueue(
  db: PostgresJsDatabase,
  limits: Limits,
  vault: KeyVault,
  notifier: Notifier,
  workflowOf: (workflowId: string) => { pins: WorkflowPin[]; outputs: OutputEntry[] } | undefined,
  /** `RUN_MODEL_OVERRIDE`, validated by `modelOverride`. */
  modelOverride: string | null,
  /** `DEFAULT_RUN_HARNESS`: the loop of a run whose start names none. */
  defaultHarness: Harness,
) {
  /** The organizations in queue priority order (`Limits`). */
  const orgs = [...limits.voluma.keys()];

  const locked = <T>(work: (tx: Tx) => Promise<T>) =>
    db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${QUEUE_LOCK})`);
      return work(tx);
    });

  type Hold = (runId: string, labId: string, keys: VisitorKeys) => void;

  /**
   * Runs a write of the browser under the lock. A refusal is an `HTTPException` thrown where it
   * is decided: it rolls the write back and reaches the client. Any failure forgets the keys the
   * work held through `hold`.
   */
  const attempt = async <T>(work: (tx: Tx, hold: Hold) => Promise<T>): Promise<T> => {
    const held: string[] = [];
    const hold: Hold = (runId, labId, keys) => {
      if (!vault.hold(runId, labId, keys))
        throw new HTTPException(429, {
          message: "Too many runs are waiting with keys; try again shortly.",
        });
      held.push(runId);
    };
    try {
      return await locked((tx) => work(tx, hold));
    } catch (error) {
      for (const id of held) vault.drop(id);
      throw error;
    }
  };

  const messageContext = {
    limits,
    pinsOf: (workflowId: string) => workflowOf(workflowId)?.pins,
  };

  const workflowFor = (workflowId: string) => {
    const workflow = workflowOf(workflowId);
    if (!workflow) throw new HTTPException(404, { message: "unknown workflow" });
    return workflow;
  };

  /** Every input must be readable (an uncompleted upload is readable only by its uploader). Returns them by id. */
  const checkInputs = async (tx: Tx, reader: Reader, ids: string[]) => {
    const found = await tx
      .select({
        id: inputs.id,
        name: inputs.name,
        status: inputs.status,
      })
      .from(inputs)
      .where(and(readableInputs(reader), inArray(inputs.id, ids)));
    const byId = new Map(found.map((input) => [input.id, input]));
    for (const id of ids) {
      const input = byId.get(id);
      if (!input) throw new HTTPException(404, { message: "unknown input" });
    }
    if (found.some((input) => input.status !== "ready"))
      throw new HTTPException(409, { message: "The scan is still uploading." });
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
    if (bad.length)
      throw new HTTPException(400, {
        message: `Not a measurement or score of this workflow: ${bad.join(", ")}.`,
      });
    if (starts.runs.length === 0) return;
    // A guest runs only on their own keys: Voluma's are for signed-in accounts.
    if (caller.guest && !starts.keys) throw new HTTPException(403, { message: GUEST_KEYS_MESSAGE });
    const credentials = starts.keys ? "visitor" : "voluma";
    const model = pickModel(modelOverride, credentials, starts.model);
    const harness = starts.harness ?? defaultHarness;
    const used = await usage(tx, reader.labId);
    for (const { id, inputId } of starts.runs) {
      const refused = admit("start", limits, reader.labId, used, { credentials });
      if (refused) throw limitRefusal(refused);
      if (starts.keys) hold(id, reader.labId, starts.keys);
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
        model,
        thinking: starts.thinking ?? DEFAULT_THINKING,
        harness,
        state: "queued",
      });
    }
  };

  return {
    /** The choices for a start, with the debug override that forces them (`GET /models`). */
    models: () => modelChoices(modelOverride),

    /**
     * Creates one run `queued` on an input of an existing study. Refuses a study the reader
     * can't read (or the example's), an input the study lacks, an input still uploading, a
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
        if (!study) throw new HTTPException(404, { message: "unknown study" });
        if (study.example) throw new HTTPException(403, { message: "Examples are read-only." });
        const [member] = await tx
          .select({ inputId: studyMembers.inputId })
          .from(studyMembers)
          .where(
            and(
              eq(studyMembers.studyId, request.studyId),
              eq(studyMembers.inputId, request.inputId),
            ),
          );
        if (!member) throw new HTTPException(404, { message: "unknown input" });
        await checkInputs(tx, reader, [request.inputId]);
        await startRuns(tx, hold, reader, caller, study, workflowFor(study.workflowId), {
          ...request,
          runs: [{ id: request.id, inputId: request.inputId }],
        });
        return { run: await loadRun(tx, request.id, orgs) };
      }),

    /**
     * Creates a study, its inputs and a `queued` run for each of `starts.runs`, in one
     * transaction: any refusal (an input, a limit, the vault) refuses the whole call and
     * leaves nothing. Returns the study's id.
     */
    createStudy: (
      reader: Reader,
      caller: Caller,
      request: {
        study: Omit<typeof studies.$inferInsert, "labId" | "createdBy" | "example" | "createdAt">;
        /** `subject` absent: the input's name. */
        inputs: (Omit<typeof studyMembers.$inferInsert, "studyId" | "position" | "subject"> & {
          subject?: string;
        })[];
        /** The runs to start now, one per input to start. */
        starts: Starts;
      },
    ) =>
      attempt(async (tx, hold) => {
        const workflow = workflowFor(request.study.workflowId);
        const found = await checkInputs(
          tx,
          reader,
          request.inputs.map((input) => input.inputId),
        );
        await tx.insert(studies).values({
          ...request.study,
          labId: reader.labId,
          createdBy: caller.userId,
        });
        await tx.insert(studyMembers).values(
          request.inputs.map((input, position) => ({
            ...input,
            subject: input.subject ?? found.get(input.inputId)!.name,
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
      await attempt(async (tx) => {
        const [run] = await loadRuns(tx, and(readableRuns(reader), eq(runs.id, runId)), orgs);
        if (!run) throw new HTTPException(404, { message: "not found" });
        if (run.example) throw new HTTPException(403, { message: "Examples are read-only." });
        vault.drop(runId);
        // A report may end the run under its own locks: take them and judge the state they leave.
        const locked = await lockRun(tx, runId);
        if (locked?.state !== "ended") await endUnfinished(tx, runId, "cancelled");
      });
      notifier.notify(runId);
      // After the commit, so a reply that cannot be read cannot roll the cancel back.
      return {
        run: await db.transaction((tx) => loadRun(tx, runId, orgs), {
          isolationLevel: "repeatable read",
        }),
      };
    },

    /** Why `caller` can't message `run` now, or null (`messageRefusal`); the run read reports it. */
    async cannotMessage(
      reader: Reader,
      caller: { userId: string; guest: boolean },
      run: Run,
      /** A caller inside a transaction passes it: a second pool connection there can exhaust the pool. */
      tx: Queryable = db,
      studyWorkflowId?: string,
    ): Promise<string | null> {
      const refusal = await messageRefusal(tx, messageContext.pinsOf, caller, {
        ...messageTargetOf(run),
        studyWorkflowId,
      });
      return refusal?.message ?? null;
    },

    /** Whether `reader` may send this message now, without storing anything (`decideMessage`). */
    checkMessage: (
      reader: Reader,
      caller: { userId: string; guest: boolean },
      runId: string,
      msg: { id: string; payload: PersonMessage; markIds?: string[] },
    ) =>
      db.transaction((tx) => decideMessage(tx, messageContext, reader, caller, runId, msg, false)),

    /** Stores the message, reopening the run if it had ended; one transaction under the queue lock. */
    async sendMessage(
      reader: Reader,
      caller: { userId: string; guest: boolean },
      runId: string,
      msg: { id: string; payload: PersonMessage; markIds?: string[] },
    ) {
      const result = await locked((tx) =>
        decideMessage(tx, messageContext, reader, caller, runId, msg, true),
      );
      if (!result.duplicate) notifier.notify(runId);
      return result;
    },

    /** Stores a yes or no to a held call, reopening the run if it had ended; never through admission. */
    async answerApproval(
      reader: Reader,
      caller: { userId: string; guest: boolean },
      runId: string,
      requestId: string,
      body: AnswerApprovalRequest,
    ) {
      const { duplicate } = await locked((tx) =>
        answerApproval(tx, messageContext, reader, caller, runId, requestId, body),
      );
      if (!duplicate) notifier.notify(runId);
    },

    /**
     * `awaiting-keys` → `queued`, for the run's own starter, holding the new keys. The run
     * stays as it was when the vault is full.
     */
    resume: (reader: Reader, runId: string, keys: VisitorKeys) =>
      attempt(async (tx, hold) => {
        const [run] = await loadRuns(tx, and(readableRuns(reader), eq(runs.id, runId)), orgs);
        if (!run) throw new HTTPException(404, { message: "not found" });
        if (run.state.status !== "awaiting-keys")
          throw new HTTPException(409, { message: "The run is not waiting for keys." });
        const refused = admit("resume", limits, reader.labId, await usage(tx, reader.labId), run);
        if (refused) throw limitRefusal(refused);
        hold(runId, reader.labId, keys);
        await tx
          .update(runs)
          .set({ state: "queued", awaitingSince: null })
          .where(eq(runs.id, runId));
        return { run: await loadRun(tx, runId, orgs) };
      }),

    /**
     * One transaction: sweep expired leases, send the queued visitor runs whose keys this
     * process doesn't hold (another process took the start, or it restarted) to
     * `awaiting-keys`, then take the first queued run in `queueOrder` that the slot caps and
     * the org's limits allow and whose loop the runner lists (a run's `harness`, null: `tasks`),
     * with its keys if it is a visitor run. The held ids are read
     * under the lock: a start that holds its keys before it commits is either in them or
     * not yet queued.
     */
    claim: (runnerId: string, harnesses: readonly Harness[]) =>
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
        // The slot caps (`Limits`): counted under the lock, from every runner process, so a
        // deploy overlap of two runners can't take more than the app's total.
        const [counts] = await tx.execute<{ running: number; ownKeyBusy: boolean }>(sql`
          SELECT count(*)::int AS running, ${ownKeyBusy} AS "ownKeyBusy"
          FROM runs WHERE state = 'running' AND NOT example`);
        if (!counts || counts.running >= limits.appRunning) return null;
        const queued = await tx
          .select()
          .from(runs)
          .where(
            and(
              eq(runs.state, "queued"),
              inArray(sql`coalesce(${runs.harness}, 'tasks')`, [...harnesses]),
            ),
          )
          .orderBy(...queueOrder(orgs));
        // Failing or skipping a run changes none of these counts, so read each org's once.
        const usages = new Map<string, Usage>();
        for (const run of queued) {
          if (run.credentials === "visitor") {
            if (counts.ownKeyBusy) continue;
          } else {
            const used = usages.get(run.labId) ?? (await usage(tx, run.labId));
            usages.set(run.labId, used);
            const refused = admit("claim", limits, run.labId, used, {
              credentials: "voluma",
              started: run.startedAt !== null,
            });
            if (refused === "concurrent") continue;
            if (refused) {
              await fail(tx, run.id, refusalError[refused]);
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
            })
            .where(eq(runs.id, run.id));
          const keys = run.credentials === "visitor" ? vault.take(run.id) : undefined;
          const [study] = await tx
            .select({ budgetUsd: studies.budgetUsd })
            .from(studies)
            .where(eq(studies.id, run.studyId));
          return {
            run: await loadRun(tx, run.id, orgs),
            leaseToken,
            budgetUsd: study?.budgetUsd ?? null,
            ...(keys && { keys }),
            ...(run.lastClaimEnd && { previousClaim: { reason: run.lastClaimEnd } }),
          };
        }
        return null;
      }),

    /**
     * Extends the lease and adds the usage; `stop` once the run has ended. Throws `LeaseLost`.
     * Under the run's event lock and row lock only, not the queue lock. Against a claim's lease
     * sweep, whichever takes the row first wins: a heartbeat first extends the lease and the
     * sweep, re-reading the row, skips it; a sweep first clears the token and the heartbeat
     * finds no row.
     */
    heartbeat: (runId: string, leaseToken: string, used: RunnerUsage) =>
      db.transaction(async (tx) => {
        const run = await lockRun(tx, runId, eq(runs.leaseToken, leaseToken));
        if (!run) throw new LeaseLost();
        if (run.state !== "running") return { stop: true };
        // An org dropped from config stops its running Voluma-key runs here (its queued ones fail at claim).
        if (run.credentials === "voluma" && !limits.voluma.has(run.labId)) {
          await fail(tx, runId, refusalError["no-key"]);
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
        const [last] = await tx
          .select({ seq: sql<number>`coalesce(max(${events.seq}), 0)` })
          .from(events)
          .where(eq(events.runId, runId));
        return { stop: false, lastSeq: last?.seq ?? 0 };
      }),

    /**
     * Throws `LeaseLost` or `RunEnded`. A failed claim of a reopened run ends it `completed`
     * (`endUnfinished`). Like `heartbeat`, under the run's own locks only: a cancel takes the
     * same two, so whichever takes the row first ends the run and the other sees it ended (`RunEnded`, or
     * the cancel returns the run as it ended).
     */
    async report(runId: string, leaseToken: string, report: RunnerReport) {
      await db.transaction(async (tx) => {
        const run = await lockRun(tx, runId, eq(runs.leaseToken, leaseToken));
        if (!run) {
          if (
            report.kind === "released" &&
            (await takeBackStrike(tx, runId, leaseToken, report.reason))
          )
            return;
          throw new LeaseLost();
        }
        if (run.state !== "running") throw new RunEnded();
        if (report.kind === "released") {
          await recover(tx, sql`id = ${runId}`, report.reason);
        } else if (report.outcome === "failed") {
          await endUnfinished(tx, runId, "failed", report.error);
        } else {
          // The researcher wrote while the claim was ending: the run goes back to the queue.
          const late = run.harness === "agents" ? await lateWrite(tx, runId, report.readSeq) : null;
          // A reopen already stored for that write cannot queue the run again: it would loop.
          if (!late || !(await reopen(tx, runId, late, run.startedBy)))
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
