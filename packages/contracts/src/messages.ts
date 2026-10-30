/**
 * Corrections: a researcher talks with a finished run's main agent from the 3D panel, and the
 * agent redoes a task on "go". The design is `iterate-and-review/design/corrections.md`.
 *
 *   POST /api/review/runs/:runId/messages   body `sendRunMessageRequestSchema` → 200 `sendRunMessageResponseSchema`
 *
 * One message, one claim. A run that ended `completed` is reopened by the message for ONE claim:
 * in one transaction, under the queue lock (taken first, as `cancel` does, then the event lock),
 * the route appends `run.reopened`, then `person.message`, resets `lastClaimEnd` and
 * `stalledClaims` (so `previousClaim` never reports a reason from before the reopen), and moves
 * the run to `queued` through admission. The next `claim.started` carries `reopened: true`
 * (its own flag; not a claim-end reason). The main agent is resumed with the message (a new
 * `main.<n>` thread when its stored history cannot resume: a run from before corrections, a
 * changed system prompt or tool list, or a recorded model the runner no longer allows; it never
 * fails the run for that), answers with `reply` (a `reply` event) and calls `finish_run`. On a
 * go it does the new attempt first, then `finish_run`. There is no waiting state.
 *
 * A message to a run that is `queued` or `running` (a reopened run, mid-claim) only appends the
 * `person.message`. The runner reads the log once per claim and cannot see it, so its end or
 * release report carries `lastSeq` (`runner.ts`): `report()`, under the queue lock, sends the run
 * back to `queued` instead of recording the report when a `person.message` has a higher `seq`.
 * The note is answered by the next claim; the panel says a note sent mid-fix waits.
 *
 * `run.reopened` (server-authored, thread `<runId>.person`, id `<runId>.person:<id>:reopened`,
 * payload `runReopenedSchema`) is written only when a message moves an ended run to `queued`. The
 * harness's thread log clears the root thread's ended flag on it (that flag otherwise ends the loop
 * and refuses every main tool), and the go gate reads "a `person.message` with `go` after the
 * latest `run.reopened`". `person.message` is on the same thread, id `<runId>.person:<id>`.
 *
 * Go. `go` requires `taskId`. Code refuses `message`, `start_worker`, `change_plan` and
 * `stop_worker` until such a go exists; every go writes `revision.started {reason: "correction",
 * taskId}` (the harness implements; so the review and the correction span have a boundary even
 * when nothing depends on the task). The main agent reads the chat as `person.message`s and writes
 * `reply` events; the panel reads `conversation(events)` (`conversation.ts`) from the run stream
 * (`GET /api/run/runs/:id/stream`, the frames the run page folds), which closes when the run
 * ends, so the panel reconnects after it posts.
 *
 * A correction never ends a run worse than `completed`. The run row stays `completed` with its
 * earlier results whatever a correction claim does. A failure or cancel of a correction claim
 * (a thread failure, the no-progress limit, a user cancel, a lease that cannot be recovered) is
 * written as `correction.ended` (server-authored, thread `<runId>.person`, id
 * `<runId>.person:<id>:ended` with the reopening message's id, payload `correctionEndedSchema`)
 * and the run ends `completed` again. The run page shows the span from `run.reopened` to the next
 * root `thread.ended` or `correction.ended`.
 *
 * Who may send: only the run's `startedBy` (403 otherwise; it also settles whose go counts).
 * Cookie auth and Origin rules are `run.ts`'s. Only this route's body limit is raised, to
 * `MESSAGE_BODY_BYTES`; the snapshot is at most `MAX_MESSAGE_SNAPSHOT_BYTES` decoded, and the
 * server checks the decoded size and the PNG signature, not only the string. The server writes it
 * to `runs/<runId>/scratch/person/<id>.png` (the sandbox's `/scratch/person/<id>.png`, which the
 * main agent's and a worker's `view_image` can open) and puts that key in `snapshotKey`.
 * Marks name a review block id; the API resolves it to the output's `/outputs` file path in the
 * text the main agent gets.
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
 * corrected); admission's refusal (`run.ts` Limits: the org's limits apply to a reopen as to a
 * start); 413: over the body or snapshot limit; 415: the snapshot is not a PNG; 503: no file
 * storage for the snapshot. A message to a `queued` or `running` reopened run is not refused.
 *
 * Spend. A correction's spend accrues on the same run and counts toward the org's day by claim
 * time (the claim that spends it, not the run's first claim), and each correction has its own cost
 * cap, a runner setting; the API implements both.
 *
 * Stored data. All of this is additive: no stored event or run row changes shape.
 */
import { z } from "zod";
import { userIdSchema } from "./auth";
import { taskIdSchema } from "./ids";
import { sha256Schema } from "./r2";
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

/** Where the server keeps a message's snapshot PNG: `scratch/person/` is readable by the main agent and workers. */
export const messageSnapshotKey = (runId: string, messageId: string) =>
  `runs/${runId}/scratch/person/${messageId}.png`;

/**
 * The payload of a `person.message` event (`events.ts`). `text` is required unless `go`: the Go
 * button may send nothing else. `taskId` is the task the panel was showing; required with `go`, which
 * tells the main agent it may now act on that task (code enforces it).
 */
export const personMessageSchema = z
  .object({
    text: z.string().max(MAX_TEXT).optional(),
    marks: z.array(markSchema).max(MAX_MARKS).optional(),
    /** `messageSnapshotKey(runId, messageId)`, written by the route. */
    snapshotKey: z
      .string()
      .regex(/^runs\/[^/]+\/scratch\/person\/[^/]+\.png$/)
      .optional(),
    taskId: taskIdSchema.optional(),
    go: z.literal(true).optional(),
  })
  .refine((m) => m.go === true || (m.text !== undefined && m.text.trim() !== ""), {
    path: ["text"],
    message: "text is required unless go",
  })
  .refine((m) => m.go !== true || m.taskId !== undefined, {
    path: ["taskId"],
    message: "go needs taskId",
  });
export type PersonMessage = z.infer<typeof personMessageSchema>;

/** The payload of `run.reopened`: who reopened the run (the message's sender, the run's `startedBy`). */
export const runReopenedSchema = z.object({ by: userIdSchema });
export type RunReopened = z.infer<typeof runReopenedSchema>;

/** The payload of `correction.ended`: a correction claim failed or was cancelled; the run stays `completed`. */
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
export const sendRunMessageRequestSchema = z
  .object({
    /** Kept across retries of the same message. */
    id: z.uuid(),
    text: z.string().max(MAX_TEXT).optional(),
    marks: z.array(markSchema).max(MAX_MARKS).optional(),
    taskId: taskIdSchema.optional(),
    go: z.literal(true).optional(),
    /** PNG bytes as plain base64 (not a data URL), at most `MAX_MESSAGE_SNAPSHOT_BYTES` decoded. */
    snapshot: z
      .object({
        mimeType: z.literal("image/png"),
        data: z.base64().max(Math.ceil(MAX_MESSAGE_SNAPSHOT_BYTES / 3) * 4),
      })
      .optional(),
  })
  .refine((m) => m.go === true || (m.text !== undefined && m.text.trim() !== ""), {
    path: ["text"],
    message: "text is required unless go",
  })
  .refine((m) => m.go !== true || m.taskId !== undefined, {
    path: ["taskId"],
    message: "go needs taskId",
  });
export type SendRunMessageRequest = z.infer<typeof sendRunMessageRequestSchema>;

export const sendRunMessageResponseSchema = z.object({
  /** The stored `person.message` event. */
  eventId: z.string().min(1),
  /** The run's state after the message: `queued` once reopened; the run's own state if it was already `queued` or `running`. */
  state: runStateSchema,
});
export type SendRunMessageResponse = z.infer<typeof sendRunMessageResponseSchema>;
