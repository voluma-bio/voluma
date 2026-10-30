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
 * A message to a run that is `queued` or `running` (a reopened run, mid-claim) only appends the
 * `person.message`. The runner reads the log once per claim and cannot see it, so its `ended`
 * report carries `lastSeq` (`runner.ts`): `report()`, under the queue lock, finds a
 * `person.message` with a higher `seq` (than the larger of `lastSeq` and the claim's start seq,
 * so a claim that failed before it read does not count the message that reopened the run), does
 * not record a completed report as the run's end, and reopens the run exactly as the route does
 * (one function, `reopen`: `run.reopened` with an id keyed to that first unseen message, the
 * run to `queued`, the spend base reset; no admission). A failed report is recorded first
 * (`correction.ended`, the run `completed`), then the run is reopened. A `released` report is recovered as always and the note waits for the next claim.
 * The note is answered by the next claim; the panel says a note sent mid-fix waits.
 *
 * `run.reopened` (server-authored, thread `<runId>.person`, id `<runId>.person:<id>:reopened`,
 * payload `runReopenedSchema`) is written by exactly these two paths: the route moving an ended
 * run to `queued`, and `report()`'s requeue. The harness's thread log clears the root thread's
 * ended flag on it (that flag otherwise ends the loop and refuses every main tool). On a requeue
 * it is stored AFTER the unseen message(s), and the harness does not take a message above its
 * claim's `claim.started.readSeq` as delivered or answered by that claim's events, though they
 * come later in the log. `person.message` is on the
 * same thread, id `<runId>.person:<id>`.
 *
 * Go. `go` requires `taskId`. When the loop's log shows a `go` the main agent has not been told
 * of, it writes `revision.started {reason: "correction", taskId}` (id `<runId>.person:<id>:go`)
 * and then tells main; that marker, not the message, opens the gate. Code refuses `message`,
 * `start_worker`, `change_plan` and `stop_worker` until a marker exists since the latest
 * `run.reopened`. A go that arrived before a requeue's `run.reopened` is still undelivered, so
 * the next claim writes its marker and opens the gate then. The marker also gives review and the
 * correction span a boundary when nothing depends on the task, and resets the task's fix rounds.
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
 * `<runId>.person:<id>:ended`, keyed to the latest `run.reopened`'s id, payload `correctionEndedSchema`)
 * and the run ends `completed` again. The run page shows the span from `run.reopened` to the next
 * root `thread.ended` or `correction.ended`. The revisions that span opened (`revision.started`
 * after the latest `run.reopened`) are not the run's result: review and progress use the revision
 * before them (`reviewState`), so a failed redo never leaves a half-redone task as the review.
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
 * are not kept, so a reopened run could not be resumed); 409: the run has not ended, or did not
 * end `completed` (a failed or cancelled run's threads were ended or cut: it is rerun, not
 * reopened), has no plan yet, or `taskId` names a skipped task (a skipped task cannot be
 * corrected), or the run was made on an older version of its workflow than the study's current
 * one (the pinned paths differ: the runner could not load its files, so it is rerun); admission's refusal (`run.ts` Limits: the org's limits apply to a reopen as to a
 * start); 413: over the body or snapshot limit; 415: the snapshot is not a PNG; 503: no file
 * storage for the snapshot. A message to a `queued` or `running` reopened run is not refused.
 *
 * Spend. A correction's spend accrues on the same run and counts toward the org's day by claim
 * time (the claim that spends it, not the run's first claim), and each correction has its own cost
 * cap, a runner setting (else the run cap), on top of the spend at the reopen; the API
 * implements both.
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

const MAX_MARKS = 20;
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
 * Its id is `<runId>.person:<messageId>:reopened`, keyed to the message that caused it: the one
 * the route stored, or on a requeue the first `person.message` the ended claim had not seen.
 */
export const runReopenedSchema = z.object({ by: userIdSchema });
export type RunReopened = z.infer<typeof runReopenedSchema>;

/**
 * The payload of `correction.ended`: a correction claim failed or was cancelled; the run stays
 * `completed`. Its id is the latest `run.reopened`'s id with `:ended` in place of `:reopened`.
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
