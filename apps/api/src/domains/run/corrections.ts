/**
 * The server's side of corrections (`@voluma/contracts/messages`): judging a researcher's message
 * to a run, reopening a finished run for it, and recording how a correction ended. The queue
 * (pg-queue.ts) calls these inside its transactions, under the queue lock.
 *
 * Lock order, everywhere: the queue lock, then the run's event lock (`eventLock`), then row
 * locks. A runner's append takes the event lock before it shares the run row (`assertLease`), so
 * a transaction that holds the row and then asks for the event lock can deadlock with it.
 */
import { runEventSchema } from "@voluma/contracts/events";
import { corrections, fold } from "@voluma/contracts/fold";
import type { PersonMessage } from "@voluma/contracts/messages";
import type { WorkflowPin } from "@voluma/contracts/workflow";
import { and, asc, eq, inArray } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import type { Reader } from "../../domain";
import type { MessageSent } from "../../ports";
import { admit, type Limits, refusalMessage, usage } from "./admission";
import { noLease } from "./lease";
import { eventLock, insertEvent } from "./pg-event-log";
import { loadRun, readableRuns, type Tx, toRunEvent } from "./pg-runs";
import { events, runs, studies } from "./schema";

const personThread = (runId: string) => `${runId}.person`;
const personEventId = (runId: string, messageId: string) => `${personThread(runId)}:${messageId}`;

/** A server-authored correction event on the run's `<runId>.person` thread. */
async function appendPersonEvent(
  tx: Tx,
  runId: string,
  event: {
    id: string;
    type: "person.message" | "run.reopened" | "correction.ended";
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
 * the message), then the run to `queued` with its end, claim history and lease cleared.
 */
async function reopen(tx: Tx, runId: string, messageEventId: string, by: string) {
  await appendPersonEvent(tx, runId, {
    id: `${messageEventId}:reopened`,
    type: "run.reopened",
    payload: { by },
  });
  await tx
    .update(runs)
    .set({
      state: "queued",
      outcome: null,
      endedAt: null,
      error: null,
      lastClaimEnd: null,
      stalledClaims: 0,
      ...noLease,
    })
    .where(eq(runs.id, runId));
}

/**
 * The id of the `run.reopened` of the open correction (`corrections`): the latest, with no
 * `correction.ended` after it. A correction that finished leaves its span open while the run is
 * `ended`, so a caller asks this only of a queued or running run.
 */
export async function openCorrection(tx: Tx, runId: string): Promise<string | null> {
  const rows = await tx
    .select()
    .from(events)
    .where(and(eq(events.runId, runId), inArray(events.type, ["run.reopened", "correction.ended"])))
    .orderBy(asc(events.seq));
  return corrections(rows.map(toRunEvent)).open?.reopenId ?? null;
}

/** Writes `correction.ended`, keyed to the open correction's `run.reopened` (`openCorrection`). */
export async function endCorrection(
  tx: Tx,
  runId: string,
  reopenId: string,
  status: "failed" | "cancelled",
  error?: string,
) {
  await appendPersonEvent(tx, runId, {
    id: `${reopenId.slice(0, -":reopened".length)}:ended`,
    type: "correction.ended",
    payload: { status, ...(error !== undefined && { error }) },
  });
}

/** The 403 a guest gets for anything that would run on Voluma's keys. */
export const GUEST_KEYS_MESSAGE =
  "Guests run on their own keys. Add your keys to start a run, or sign in with an account to use Voluma's.";

/**
 * A researcher's message to a run, judged in the order the contract lists the refusals. `write`
 * false judges only (nothing is stored, no lock is taken): the route calls that first, so a
 * refused message stores no snapshot, and again with `write` under the queue lock. A run that
 * ended `completed` is reopened through admission. A run still queued or running takes no message
 * (one message, one claim). A run whose workflow files are not the study's current ones cannot
 * be reopened: the runner could not load them.
 */
export async function decideMessage(
  tx: Tx,
  o: { limits: Limits; pinsOf: (workflowId: string) => WorkflowPin[] | undefined },
  reader: Reader,
  caller: { userId: string; guest: boolean },
  runId: string,
  msg: { id: string; payload: PersonMessage },
  write: boolean,
): Promise<MessageSent> {
  const { userId } = caller;
  if (write) await eventLock(tx, runId);
  const found = tx
    .select()
    .from(runs)
    .where(and(readableRuns(reader), eq(runs.id, runId)));
  const [run] = await (write ? found.for("update") : found);
  if (!run) throw new HTTPException(404, { message: "not found" });
  if (run.startedBy !== userId) {
    throw new HTTPException(403, {
      message: "Only the person who started the run can write to it.",
    });
  }
  if (run.example) throw new HTTPException(403, { message: "Examples are read-only." });
  if (run.credentials === "visitor") {
    throw new HTTPException(403, {
      message: "A run with your own keys keeps no keys, so it cannot be reopened.",
    });
  }
  // Only a run on Voluma's keys is left here, and a guest has none of their own to reopen it on.
  if (caller.guest) {
    throw new HTTPException(403, { message: GUEST_KEYS_MESSAGE });
  }
  const eventId = personEventId(runId, msg.id);
  const [again] = await tx
    .select({ id: events.id })
    .from(events)
    .where(and(eq(events.runId, runId), eq(events.id, eventId)));
  const stateNow = async () => (await loadRun(tx, runId)).state;
  if (again) return { eventId, state: await stateNow(), duplicate: true };

  if (run.state === "queued" || run.state === "running") {
    throw new HTTPException(409, {
      message:
        (await openCorrection(tx, runId)) !== null
          ? "The run is still answering your last message. Wait for its reply, or cancel it."
          : "The run has not finished yet.",
    });
  }
  if (run.state !== "ended" || run.outcome !== "completed") {
    throw new HTTPException(409, {
      message: "Only a run that completed can be reopened; rerun this one.",
    });
  }
  const [study] = await tx
    .select({ workflowId: studies.workflowId })
    .from(studies)
    .where(eq(studies.id, run.studyId));
  const current = study && o.pinsOf(study.workflowId);
  const pathsOf = (pins: readonly WorkflowPin[]) => pins.map((p) => p.path ?? "").sort();
  if (!current || pathsOf(current).join() !== pathsOf(run.workflows as WorkflowPin[]).join()) {
    throw new HTTPException(409, {
      message: "This run used an older version of its workflow, so rerun it.",
    });
  }
  const { taskId } = msg.payload;
  const view = fold(
    (
      await tx
        .select()
        .from(events)
        .where(
          and(
            eq(events.runId, runId),
            inArray(events.type, [
              "revision.started",
              "plan.changed",
              "run.reopened",
              "correction.ended",
            ]),
          ),
        )
        .orderBy(asc(events.seq))
    ).map(toRunEvent),
  );
  if (view.plan.tasks.length === 0)
    throw new HTTPException(409, { message: "The run has no plan yet." });
  if (taskId !== undefined) {
    if (!view.plan.tasks.some((t) => t.id === taskId)) {
      throw new HTTPException(404, { message: `${taskId} is not a task of this run.` });
    }
    if (view.tasks.find((t) => t.id === taskId)?.skipped) {
      throw new HTTPException(409, {
        message: `${taskId} was skipped, so it cannot be corrected.`,
      });
    }
  }
  const refused = admit(
    "reopen",
    o.limits,
    await usage(tx, reader.labId, { userId, credentials: run.credentials }),
    run,
  );
  if (refused) throw new HTTPException(409, { message: refusalMessage[refused] });
  if (!write) return { eventId, state: await stateNow(), duplicate: false };

  await reopen(tx, runId, eventId, userId);
  await appendPersonEvent(tx, runId, {
    id: eventId,
    type: "person.message",
    payload: msg.payload,
  });
  return { eventId, state: await stateNow(), duplicate: false };
}
