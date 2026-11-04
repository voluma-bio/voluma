/**
 * The server's side of corrections (`@voluma/contracts/messages`): judging a researcher's message
 * to a run, and reopening a finished run for it. The queue
 * (pg-queue.ts) calls these inside its transactions (locks: `apps/api/AGENTS.md`).
 *
 * Lock order: `lockRun` (`pg-event-log.ts`).
 */
import { approvalAnswerId, approvalSettledId } from "@voluma/contracts/agents";
import { runEventSchema } from "@voluma/contracts/events";
import type { AnswerApprovalRequest, PersonMessage } from "@voluma/contracts/messages";
import { outputsFold } from "@voluma/contracts/output-fold";
import type { Run } from "@voluma/contracts/run";
import type { WorkflowPin } from "@voluma/contracts/workflow";
import { and, asc, eq, inArray } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import type { Caller, Reader } from "../../domain";
import type { MessageSent } from "../../ports";
import { admit, type Limits, refusalMessage, spentUsd } from "./admission";
import { freezeAttached } from "./agent-review";
import { noLease } from "./lease";
import { eventLock, insertEvent, lockRun } from "./pg-event-log";
import {
  loadRun,
  openCorrectionOf,
  type Queryable,
  readableRuns,
  readEvents,
  type Tx,
} from "./pg-runs";
import type { KeySealer } from "./run-keys";
import { events, runs, studies } from "./schema";

const personThread = (runId: string) => `${runId}.person`;
const personEventId = (runId: string, messageId: string) => `${personThread(runId)}:${messageId}`;

/** A server-authored correction event on the run's `<runId>.person` thread. */
async function appendPersonEvent(
  tx: Tx,
  runId: string,
  event: {
    id: string;
    type: "person.message" | "run.reopened" | "approval.given" | "approval.declined";
    payload: unknown;
  },
) {
  await eventLock(tx, runId);
  return insertEvent(
    tx,
    runEventSchema.parse({
      ...event,
      runId,
      threadId: personThread(runId),
      seq: 0,
      createdAt: new Date().toISOString(),
    }),
  );
}

/**
 * Reopens a finished run for the person's message `messageEventId`: `run.reopened` (id keyed to
 * the message), then the run to `queued` with its end, claim history and lease cleared. Returns
 * false, changing nothing, when that `run.reopened` is already stored.
 */
export async function reopen(
  tx: Tx,
  runId: string,
  messageEventId: string,
  by: string,
  /** An own-key run's new sealed keys: the ones it held were wiped when it ended. */
  sealedKeys?: string | null,
) {
  const [stored] = await appendPersonEvent(tx, runId, {
    id: `${messageEventId}:reopened`,
    type: "run.reopened",
    payload: { by },
  });
  if (!stored) return false;
  await tx
    .update(runs)
    .set({
      state: "queued",
      outcome: null,
      endedAt: null,
      error: null,
      lastClaimEnd: null,
      struckLeaseToken: null,
      stalledClaims: 0,
      ...(sealedKeys && { sealedKeys }),
      ...noLease,
    })
    .where(eq(runs.id, runId));
  return true;
}

/**
 * The id of the `run.reopened` of the open correction (`corrections`): the latest, with no
 * `correction.ended` after it. A correction that finished leaves its span open while the run is
 * `ended`, so a caller asks this only of a queued or running run.
 */
export async function openCorrection(tx: Queryable, runId: string): Promise<string | null> {
  const rows = await tx
    .select({ id: events.id, type: events.type, seq: events.seq })
    .from(events)
    .where(and(eq(events.runId, runId), inArray(events.type, ["run.reopened", "correction.ended"])))
    .orderBy(asc(events.seq));
  return openCorrectionOf(rows)?.id ?? null;
}

/** What the reopen of a finished run needs besides the run: how to workflow-check it and seal keys. */
export type ReopenContext = {
  pinsOf: (workflowId: string) => WorkflowPin[] | undefined;
  sealer: KeySealer;
};

/**
 * The sealed keys a reopen stores. An own-key run's keys were wiped when it ended, so the request
 * brings them; a Voluma-key run holds none.
 */
function reopenKeys(
  sealer: KeySealer,
  caller: Caller,
  run: { id: string; credentials: Run["credentials"] },
) {
  if (run.credentials === "voluma") return null;
  if (!caller.keys)
    throw new HTTPException(403, {
      message:
        "This run used your own key, which Voluma does not keep after a run. Add your key to reopen it.",
    });
  return sealer.seal(run.id, caller.keys);
}

/** What `messageRefusal` judges of a run: a run row's columns, or a `Run` read (`messageTargetOf`). */
export type MessageTarget = {
  id: string;
  startedBy: string;
  studyId: string;
  example: boolean;
  credentials: Run["credentials"];
  workflows: WorkflowPin[];
  /** The study's workflow when the caller already holds it, which spares the lookup. */
  studyWorkflowId?: string;
  /** The queue state: `queued`, `running` or `ended`. */
  state: string;
  outcome: string | null;
};

export function messageTargetOf(run: Run): MessageTarget {
  const { state } = run;
  return {
    ...run,
    state: state.status,
    outcome: state.status === "ended" ? state.outcome : null,
  };
}

/**
 * Why this caller can't message this run now, or null: the run-level part of the refusals the
 * contract lists, in its order. Nothing here is per message (a repeated id, the task to redo, its
 * item) or transient (the run limit), and the empty plan is checked beside the plan it reads: a
 * completed run always has one. `decideMessage` throws what this returns and the run read
 * reports its message (`runReadSchema.cannotMessage`), so they cannot differ.
 */
export async function messageRefusal(
  tx: Queryable,
  pinsOf: (workflowId: string) => WorkflowPin[] | undefined,
  run: MessageTarget,
): Promise<{ status: 403 | 409; message: string } | null> {
  if (run.example) return { status: 403, message: "Example runs can't be changed." };
  // A converted run (it holds the outputs the conversion wrote) keeps the workflow files of its
  // task-loop days, which the runner can no longer load; it goes with the snapshot fallback's deletion.
  const [converted] = await tx
    .select({ id: events.id })
    .from(events)
    .where(and(eq(events.runId, run.id), eq(events.id, `convert:${run.id}:outputs`)));
  if (converted)
    return {
      status: 409,
      message:
        "This run was converted from an earlier version of Voluma and can't be reopened yet.",
    };
  // A run takes the researcher's words while it goes: the claim pulls them in.
  if (run.state === "queued" || run.state === "running") return null;
  if (run.state !== "ended" || run.outcome !== "completed")
    return { status: 409, message: "Only a run that completed can be reopened; rerun this one." };
  const workflowId =
    run.studyWorkflowId ??
    (
      await tx.select({ id: studies.workflowId }).from(studies).where(eq(studies.id, run.studyId))
    )[0]?.id;
  const current = workflowId && pinsOf(workflowId);
  const pathsOf = (pins: readonly WorkflowPin[]) => pins.map((p) => p.path ?? "").sort();
  if (!current || pathsOf(current).join() !== pathsOf(run.workflows).join())
    return { status: 409, message: "This run used an older version of its workflow, so rerun it." };
  return null;
}

/**
 * A researcher's message to a run, judged in the order the contract lists the refusals. `write`
 * false judges only (nothing is stored, no lock is taken): the route calls that first, so a
 * refused message stores no snapshot, and again with `write` inside the queue's transaction. A run that
 * ended `completed` is reopened through admission. A run still queued or running takes the message
 * as it is (the claim pulls it in). A run whose workflow files are not the study's current ones cannot
 * be reopened: the runner could not load them.
 */
export async function decideMessage(
  tx: Tx,
  o: ReopenContext & { limits: Limits },
  reader: Reader,
  caller: Caller,
  runId: string,
  msg: { id: string; payload: PersonMessage; markIds?: string[] },
  write: boolean,
): Promise<MessageSent> {
  const { userId } = caller;
  const run = write
    ? await lockRun(tx, runId, readableRuns(reader))
    : (
        await tx
          .select()
          .from(runs)
          .where(and(readableRuns(reader), eq(runs.id, runId)))
      )[0];
  if (!run) throw new HTTPException(404, { message: "not found" });
  const refusal = await messageRefusal(tx, o.pinsOf, {
    ...run,
    workflows: run.workflows as WorkflowPin[],
  });
  const eventId = personEventId(runId, msg.id);
  const [again] = await tx
    .select({ id: events.id })
    .from(events)
    .where(and(eq(events.runId, runId), eq(events.id, eventId)));
  const stateNow = async () => (await loadRun(tx, runId, [...o.limits.voluma.keys()])).state;
  // A message already stored is answered even though the run is busy answering it.
  if (again && refusal?.status !== 403)
    return { eventId, state: await stateNow(), duplicate: true };
  if (refusal) throw new HTTPException(refusal.status, { message: refusal.message });
  // The runner resumes from the whole log and fails on a row it can't read, so a correction on
  // such a run could never finish. Both passes read it all, so a refused message never uploads
  // a snapshot first.
  const { events: log, skipped } = readEvents(
    await tx.select().from(events).where(eq(events.runId, runId)).orderBy(asc(events.seq)),
  );
  if (skipped.length)
    throw new HTTPException(409, {
      message: "This run has an event that can't be read; rerun it.",
    });
  let payload = msg.payload;
  // Main reads the log. Check what the message points at, and freeze its marks from the log so
  // a later `mark.placed` cannot change a sent message.
  const outputs = outputsFold(log).byId;
  const { output, toCheck } = payload;
  if ([output, toCheck?.output].some((id) => id !== undefined && !outputs.has(id)))
    throw new HTTPException(404, { message: "Output not found." });
  if (
    toCheck &&
    !outputs.get(toCheck.output)?.versions.find((v) => v.version === toCheck.version)?.toCheck[
      toCheck.item
    ]
  )
    throw new HTTPException(404, { message: "To check item not found." });
  const attached = freezeAttached(log, userId, msg.markIds ?? []);
  if (attached.length) payload = { ...payload, attached };
  else if ((msg.markIds ?? []).length && !payload.text?.trim())
    throw new HTTPException(400, {
      message: "Nothing new to send: those marks are as main last saw them.",
    });
  // A run still going was admitted already; only a finished one is reopened through admission.
  const reopening = run.state === "ended";
  const sealedKeys = reopening ? reopenKeys(o.sealer, caller, run) : null;
  if (reopening) {
    const refused = admit(o.limits, reader.labId, await spentUsd(tx, reader.labId), run);
    if (refused === "no-key")
      throw new HTTPException(403, {
        message:
          "This run used Voluma's key, which this account does not have. Rerun it on your own key.",
      });
    if (refused) throw new HTTPException(409, { message: refusalMessage[refused] });
  }
  if (!write) return { eventId, state: await stateNow(), duplicate: false };

  if (reopening) await reopen(tx, runId, eventId, userId, sealedKeys);
  await appendPersonEvent(tx, runId, { id: eventId, type: "person.message", payload });
  return { eventId, state: await stateNow(), duplicate: false };
}

/**
 * The researcher's yes or no to a held call (`answerApprovalRequestSchema`). Judged like a
 * message (the run-level refusals, in order, and the unreadable-event 409) but never through
 * admission: an answer belongs to a run already admitted, so a researcher at their limit can
 * still answer. 404 for a run that has no such request open. The same answer again stores
 * nothing; the other answer is 409. An ended run is reopened in the same transaction.
 */
export async function answerApproval(
  tx: Tx,
  o: ReopenContext,
  reader: Reader,
  caller: Caller,
  runId: string,
  requestId: string,
  body: AnswerApprovalRequest,
): Promise<{ duplicate: boolean }> {
  const run = await lockRun(tx, runId, readableRuns(reader));
  if (!run) throw new HTTPException(404, { message: "not found" });
  const refusal = await messageRefusal(tx, o.pinsOf, {
    ...run,
    workflows: run.workflows as WorkflowPin[],
  });
  const type = body.answer === "yes" ? "approval.given" : "approval.declined";
  const answerId = approvalAnswerId(requestId);
  // An answer already stored is answered even though the run's state has moved on since.
  const [stored] = await tx
    .select({ type: events.type })
    .from(events)
    .where(and(eq(events.runId, runId), eq(events.id, answerId)));
  if (stored && refusal?.status !== 403) {
    if (stored.type === type) return { duplicate: true };
    throw new HTTPException(409, { message: "That request was answered the other way." });
  }
  if (refusal) throw new HTTPException(refusal.status, { message: refusal.message });
  const { events: log, skipped } = readEvents(
    await tx.select().from(events).where(eq(events.runId, runId)).orderBy(asc(events.seq)),
  );
  if (skipped.length)
    throw new HTTPException(409, {
      message: "This run has an event that can't be read; rerun it.",
    });
  const request = log.find((e) => e.type === "approval.requested" && e.id === requestId);
  if (request?.type !== "approval.requested")
    throw new HTTPException(404, { message: "That request is not open." });
  if (log.some((e) => e.id === approvalSettledId(requestId)))
    throw new HTTPException(404, { message: "That request is not open." });

  if (run.state === "ended")
    await reopen(tx, runId, answerId, caller.userId, reopenKeys(o.sealer, caller, run));
  await appendPersonEvent(tx, runId, {
    id: answerId,
    type,
    payload: {
      toolCallId: request.payload.toolCallId,
      ...(body.text !== undefined && { text: body.text }),
    },
  });
  return { duplicate: false };
}
