/**
 * Corrections: a researcher talks with a finished run's main agent from the 3D panel, and the
 * agent redoes a task on "go". The design is `iterate-and-review/design/corrections.md`.
 *
 *   POST /api/review/runs/:runId/messages   body `sendRunMessageRequestSchema` → 200 `sendRunMessageResponseSchema`
 *
 * One message, one claim. A run that ended `completed` is reopened by the message for ONE claim:
 * in one transaction, under the queue lock (taken first, then the event lock, then row locks:
 * the order every transaction that changes a run takes, `corrections.ts`), the route appends
 * `run.reopened`, then `person.message`, resets `lastClaimEnd` and `stalledClaims` (so
 * `previousClaim` never reports a reason from before the reopen), and moves the run to
 * `queued` through admission. The main agent is resumed with the message (a new
 * `main.<n>` thread when its stored history cannot resume: a run from before corrections, a
 * changed system prompt or tool list, or a recorded model the runner no longer allows; it never
 * fails the run for that), answers with `reply` (a `reply` event) and calls `finish_run`. On a
 * go it does the new attempt first, then `finish_run`. There is no waiting state.
 *
 * A reopen claim. The claim response carries no flag; the runner knows its claim follows a reopen
 * when a `run.reopened` is stored after the latest `claim.started` (the harness's thread log
 * folds that), and then writes `claim.started {resumed: true, reopened: true}` (`events.ts`; a
 * resumed claim has exactly one of `after` and `reopened`).
 *
 * A message to a run that is `queued` or `running` is refused (409): the run is still answering
 * the last one. The sender sees the refusal and keeps the text; the panel says a note sent
 * mid-fix waits. So a span (`corrections`, fold.ts) is a `run.reopened` followed by its one
 * `person.message`, written together, and a run's claim never sees a message it did not start
 * from.
 *
 * `run.reopened` (server-authored, thread `<runId>.person`, id `<runId>.person:<id>:reopened`,
 * payload `runReopenedSchema`) is written by the route alone, moving an ended run to `queued`.
 * The harness's thread log clears the root thread's ended flag on it (that flag otherwise ends
 * the loop and refuses every main tool). `person.message` is on the same thread, id
 * `<runId>.person:<id>`.
 *
 * Go. `go` requires `taskId`. When the loop's log shows the span's go the main agent has not been
 * told of, it writes `revision.started {reason: "correction", taskId}` (id `<person.message id>:go`)
 * and then tells main; that marker, not the message, opens the gate. Code refuses `message`,
 * `start_worker`, `change_plan` and `stop_worker` until the span holds a marker. A go of a span
 * that ended (`correction.ended`) before main acted is void: later messages tell main so and start
 * no work. The marker also gives review and the correction span a boundary when nothing depends
 * on the task, and resets the task's fix rounds.
 * The main agent reads the chat as `person.message`s and writes
 * `reply` events; the panel reads `conversation(events)` (`conversation.ts`) from the run stream
 * (`GET /api/run/runs/:id/stream`, the frames the run page folds), which closes when the run
 * ends, so the panel reconnects after it posts.
 *
 * A correction never ends a run worse than `completed`. The run row stays `completed` with its
 * earlier results whatever a correction claim does, except that review is unavailable meanwhile:
 * while a reopened run is `queued` or `running`, `runSchema` carries no `review` (it is present
 * only on an `ended`/`completed` run) and accept and mark-reviewed answer 409. The panel and Home
 * show that the run is being corrected; review returns when the claim ends. A failure or cancel of a correction claim
 * (a thread failure, the main agent stopping moving, the no-progress limit, a user cancel, a
 * lease that cannot be recovered, a claim that cannot load the run's workflow) is
 * written as `correction.ended` (server-authored, thread `<runId>.person`, id
 * `<runId>.person:<id>:ended`, keyed to the open correction's `run.reopened`, payload `correctionEndedSchema`)
 * and the run ends `completed` again. The run page shows the span from `run.reopened` to the next
 * root `thread.ended` or `correction.ended`. The task-state events of that span (attempts, task,
 * checkpoints, outputs, plan changes, revisions) are abandoned (`abandonedEvents`, fold.ts): the
 * fold, review, the run page and the harness's own scans skip them, so a failed redo leaves
 * no half-redone task. The files the correction wrote to `/outputs` are put back too: the first
 * claim of a correction whose span holds a go (or any, when the main role holds `bash`) copies the
 * whole outputs prefix to a backup keyed to its reopen (`outputs.backed-up`, before any thread
 * runs; only a go can lead to a write while main holds no `bash`, so a message-only correction
 * makes none), and the first claim after `correction.ended` restores it exactly and checks
 * `/outputs` matches it (`outputs.restored`, `outputs-backup.ts` in the harness), so the next
 * correction starts from the pre-go state, files included. The restore is lazy: until that
 * claim, `/outputs` keeps the abandoned files, which is safe because only sandboxes read
 * `/outputs` and the restore runs before any sandbox starts. The first claim of the next
 * `run.reopened` deletes the backup of a correction that finished (`outputs.discarded`).
 * An abandoned correction also ends every thread that ran in it, finished ones too
 * (`cancelEnds`, threads.ts), so the next correction starts fresh threads: none resumes with
 * memory of work that was reverted. `corrections` (fold.ts) is the one reader of these spans.
 * Messages, replies, thread events, `run.reopened` and `correction.ended` stay.
 *
 * Who may send: only the run's `startedBy` (403 otherwise; it also settles whose go counts).
 * Cookie auth and Origin rules are `run.ts`'s. Only this route's body limit is raised, to
 * `MESSAGE_BODY_BYTES`; the snapshot is at most `MAX_MESSAGE_SNAPSHOT_BYTES` decoded, and the
 * server checks the decoded size and the PNG signature, not only the string. The server writes it
 * to `runs/<runId>/scratch/person/<id>.png` (the sandbox's `/scratch/person/<id>.png`, which the
 * main agent's and a worker's `view_image` can open) and puts that key in `snapshotKey`.
 * Marks name a review block id; the harness resolves it to the output's sandbox file path
 * (`/outputs/...`, or `/scratch/...` for a scratch file) in the text the main agent gets.
 *
 * Idempotent: the caller keeps `id` across retries. A retry with the same `id` stores nothing new
 * and answers 200 with the original event id and the run's current state. The server stamps
 * `createdAt`.
 *
 * Refusals. 400: invalid body; 404: unknown or unreadable run, or a `taskId` the run has no
 * plan for; 403: not the run's `startedBy`, a read-only example run, or a `visitor` run (its keys
 * are not kept, so a reopened run could not be resumed); 409: the run has not ended (a run still answering a message is told to wait for the reply or cancel), or did not
 * end `completed` (a failed or cancelled run's threads were ended or cut: it is rerun, not
 * reopened), has no plan yet, or `taskId` names a skipped task (a skipped task cannot be
 * corrected), or the run was made on an older version of its workflow than the study's current
 * one (the pinned paths differ: the runner could not load its files, so it is rerun); admission's refusal (`run.ts` Limits: the org's limits apply to a reopen as to a
 * start); 413: over the body or snapshot limit; 415: the snapshot is not a PNG; 503: no file
 * storage for the snapshot.
 *
 * Spend. A correction's spend accrues on the same run and is recorded and shown; there is no cap.
 *
 * Stored data. All of this is additive: no stored event or run row changes shape.
 */
import { z } from "zod";
import { userIdSchema } from "./auth";
import { taskIdSchema } from "./ids";
import { voxelBoxSchema, voxelIndexSchema } from "./review";
import { runStateSchema } from "./run";

/** A view snapshot PNG, at most this many bytes after decoding. */
export const MAX_MESSAGE_SNAPSHOT_BYTES = 2 * 1024 * 1024;
/** The body limit for the messages route: the base64 snapshot plus the text and marks. */
export const MESSAGE_BODY_BYTES = 3 * 1024 * 1024;

export const MAX_MARKS = 20;
const MAX_TEXT = 10_000;

/**
 * Where the researcher pointed: a voxel or an inclusive box on a volume's grid, `[z, y, x]`
 * (the `focusSchema` shape without its output ids). Exactly one of `point` and `box`.
 * `volumeId` is a volume block id of the task's revision (`ReviewRun`), as `Focus.volumeId`.
 */
export const markSchema = z
  .object({
    volumeId: z.string().min(1),
    point: voxelIndexSchema.optional(),
    box: voxelBoxSchema.optional(),
  })
  .refine((m) => (m.point === undefined) !== (m.box === undefined), {
    message: "a mark has a point or a box, not both and not neither",
  });
export type Mark = z.infer<typeof markSchema>;

/** The fields a person writes, shared by the request and the stored payload. */
const messageBase = {
  text: z.string().max(MAX_TEXT).optional(),
  marks: z.array(markSchema).max(MAX_MARKS).optional(),
  taskId: taskIdSchema.optional(),
  go: z.literal(true).optional(),
};

type MessageRules = { text?: string; marks?: unknown[]; taskId?: string; go?: true };

/** `text` unless `go`; `taskId` with `go` or with marks. */
function messageRules<T extends z.ZodType<MessageRules>>(schema: T) {
  return schema
    .refine((m) => m.go === true || (m.text !== undefined && m.text.trim() !== ""), {
      path: ["text"],
      message: "text is required unless go",
    })
    .refine((m) => m.go !== true || m.taskId !== undefined, {
      path: ["taskId"],
      message: "go needs taskId",
    })
    .refine((m) => (m.marks ?? []).length === 0 || m.taskId !== undefined, {
      path: ["taskId"],
      message: "marks need taskId: a mark names a block of that task's revision",
    });
}

/**
 * The payload of a `person.message` event (`events.ts`). `text` is required unless `go`: the Go
 * button may send nothing else. `taskId` is the task the panel was showing; required with `go`
 * (it tells the main agent it may now act on that task; code enforces it) and with marks.
 */
export const personMessageSchema = messageRules(
  z.object({
    ...messageBase,
    /** `messageSnapshotKey(runId, messageId)` (`r2.ts`), written by the route. */
    snapshotKey: z
      .string()
      .regex(/^runs\/[^/]+\/scratch\/person\/[^/]+\.png$/)
      .optional(),
  }),
);
export type PersonMessage = z.infer<typeof personMessageSchema>;

/**
 * The payload of `run.reopened`: who reopened the run (the message's sender, the run's `startedBy`).
 * Its id is `<runId>.person:<messageId>:reopened`, keyed to the message that caused it.
 */
export const runReopenedSchema = z.object({ by: userIdSchema });
export type RunReopened = z.infer<typeof runReopenedSchema>;

/**
 * The payload of `correction.ended`: a correction claim failed or was cancelled; the run stays
 * `completed`. Its id is the open correction's `run.reopened` id with `:ended` in place of `:reopened`.
 */
export const correctionEndedSchema = z.object({
  status: z.enum(["failed", "cancelled"]),
  /** Why it failed, redacted of key values, as `reportRequestSchema`'s `error`. */
  error: z.string().optional(),
});
export type CorrectionEnded = z.infer<typeof correctionEndedSchema>;

/** The payload of a `reply` event: the main agent's answer to the person. */
export const replySchema = z.object({ text: z.string().min(1) });
export type Reply = z.infer<typeof replySchema>;

/** The request body: a `personMessageSchema` with the snapshot as base64 bytes, and the caller's retry id. */
export const sendRunMessageRequestSchema = messageRules(
  z.object({
    /** Kept across retries of the same message. */
    id: z.uuid(),
    ...messageBase,
    /** PNG bytes as plain base64 (not a data URL), at most `MAX_MESSAGE_SNAPSHOT_BYTES` decoded. */
    snapshot: z
      .object({
        mimeType: z.literal("image/png"),
        data: z.base64().max(Math.ceil(MAX_MESSAGE_SNAPSHOT_BYTES / 3) * 4),
      })
      .optional(),
  }),
);
export type SendRunMessageRequest = z.infer<typeof sendRunMessageRequestSchema>;

export const sendRunMessageResponseSchema = z.object({
  /** The stored `person.message` event. */
  eventId: z.string().min(1),
  /** The run's state after the message: `queued` once reopened; the run's own state if it was already `queued` or `running`. */
  state: runStateSchema,
});
export type SendRunMessageResponse = z.infer<typeof sendRunMessageResponseSchema>;
