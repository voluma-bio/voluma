/**
 * Corrections: a researcher talks with a run's main agent from the 3D panel, marks and a view
 * snapshot attached.
 *
 *   POST /api/review/runs/:runId/messages   body `sendRunMessageRequestSchema` → 200 `sendRunMessageResponseSchema`
 *
 * A message to a `queued` or `running` run is stored as it is (no reopen): the claim pulls it in,
 * or reads it at its start, and `report()` reopens a run whose claim ended with one unread
 * (`readSeq`). A run that ended `completed` is reopened by the message for ONE claim: in one
 * transaction, under the queue lock (lock order: see `lockRun`, `pg-event-log.ts`), the route
 * appends `run.reopened`, then `person.message`, resets `lastClaimEnd` and `stalledClaims` (so
 * `previousClaim` never reports a reason from before the reopen), and moves the run to `queued`
 * through admission. A span (`corrections.ts`) is a `run.reopened` followed by its one
 * `person.message`, written together.
 *
 * A reopen claim. The claim response carries no flag; the runner knows its claim follows a reopen
 * when a `run.reopened` is stored after the latest `claim.started` (`AgentLog.reopenPending`),
 * and then writes `claim.started {resumed: true, reopened: true}` (`events.ts`; a resumed claim
 * has exactly one of `after` and `reopened`).
 *
 * `run.reopened` (server-authored, thread `<runId>.person`, id `<runId>.person:<id>:reopened`,
 * payload `runReopenedSchema`) is written by the route alone, moving an ended run to `queued`.
 * `person.message` is on the same thread, id `<runId>.person:<id>`.
 *
 * A correction never ends a run worse than `completed`: a failure or cancel of a correction claim
 * (a thread failure, the no-progress limit, a user cancel, a lease that cannot be recovered)
 * ends the claim's workers and the root, leaves main cut off for the researcher's next message,
 * and the run ends `completed` again. (`correction.ended`, `correctionEndedSchema`, is what an
 * earlier version wrote for this; runs keep theirs.) The run page shows the span from
 * `run.reopened` to the next root `thread.ended` or `correction.ended`.
 *
 * Who may send: only the run's `startedBy` (403 otherwise). Cookie auth and Origin rules are
 * `run.ts`'s. Only this route's body limit is raised, to `MESSAGE_BODY_BYTES`; the snapshot is at
 * most `MAX_MESSAGE_SNAPSHOT_BYTES` decoded, and the server checks the decoded size and the PNG
 * signature, not only the string. The server writes it to `runs/<runId>/scratch/person/<id>.png`
 * (the harness copies it to `/work/main/person/<id>.png`, which the main agent's and a worker's
 * `read` can open) and puts that key in `snapshotKey`.
 *
 * Idempotent: the caller keeps `id` across retries. A retry with the same `id` stores nothing new
 * and answers 200 with the original event id and the run's current state. The server stamps
 * `createdAt`.
 *
 * `GET /api/run/runs/:id` reports the run-level refusals ahead of time as `cannotMessage` (`runReadSchema`),
 * from the function the send uses, so a client never copies the rules.
 *
 * Refusals. 400: invalid body; 404: unknown or unreadable run, or an output or To check item the
 * run does not have; 403: a read-only example run, not the run's `startedBy`, or a `visitor` run
 * (its keys are not kept, so a reopened run could not be resumed), or a guest on a run made with
 * Voluma's keys; 409: the run did not end `completed` (a failed or cancelled run's threads were
 * ended or cut: it is rerun, not reopened), or was made on an older version of its workflow than
 * the study's current one (the pinned paths differ: the runner could not load its files, so it is
 * rerun); admission's refusal (`run.ts` Limits: the org's limits apply to a reopen as to a start);
 * 413: over the body or snapshot limit; 415: the snapshot is not a PNG; 503: no file storage for
 * the snapshot.
 *
 * Spend. A correction's spend accrues on the same run and is recorded and shown; there is no cap.
 */
import { z } from "zod";
import { acceptToCheckRequestSchema, attachedSchema, MAX_VIEW_BYTES } from "./agent-events";
import { userIdSchema } from "./auth";
import { positionZyx } from "./output";
import { outputRefSchema, viewSchema } from "./output-catalog";
import { voxelBoxSchema, voxelIndexSchema } from "./review";
import { runStateSchema } from "./run";

/** A view snapshot PNG, at most this many bytes after decoding. */
export const MAX_MESSAGE_SNAPSHOT_BYTES = 2 * 1024 * 1024;
/** The body limit for the messages route: the base64 snapshot plus the text and marks. */
export const MESSAGE_BODY_BYTES = 3 * 1024 * 1024;

/** The most marks one message carries. */
export const MAX_MARKS = 20;
const MAX_TEXT = 10_000;

/**
 * A line between two positions, voxel `[z, y, x]` (sub-voxel allowed), named as the AI's `line`
 * annotation (`output.ts`). `lengthMm` is what the browser showed, from the grid's spacing; the
 * server does not check it.
 */
const lineMarkSchema = z.object({
  aZyx: positionZyx,
  bZyx: positionZyx,
  lengthMm: z.number().min(0),
});

/**
 * A closed outline drawn on one slice: full `[z, y, x]` points that all share one value on
 * `axis` (0 z, 1 y, 2 x: the array axis, not an anatomical plane); the last point joins the first. `areaMm2` is what
 * the browser showed; the server does not check it.
 */
const outlineMarkSchema = z
  .object({
    axis: z.union([z.literal(0), z.literal(1), z.literal(2)]),
    zyx: z.array(positionZyx).min(3).max(500),
    areaMm2: z.number().min(0),
  })
  .refine((o) => o.zyx.every((p) => p[o.axis] === o.zyx[0]?.[o.axis]), {
    message: "every outline point has the same value on the axis",
  });

/**
 * Where the researcher pointed: a voxel, an inclusive box, a line or an outline on a volume's
 * grid, `[z, y, x]` (point and box are the `focusSchema` shape without its output ids). Exactly
 * one of `point`, `box`, `line` and `outline`.
 * `volumeId` is an output id of the catalog, as `Focus.volumeId`.
 */
export const markSchema = z
  .object({
    volumeId: z.string().min(1),
    point: voxelIndexSchema.optional(),
    box: voxelBoxSchema.optional(),
    line: lineMarkSchema.optional(),
    outline: outlineMarkSchema.optional(),
  })
  .refine((m) => [m.point, m.box, m.line, m.outline].filter((v) => v !== undefined).length === 1, {
    message: "a mark has exactly one of point, box, line and outline",
  });
export type Mark = z.infer<typeof markSchema>;

/** The fields a person writes, shared by the request and the stored payload. */
const messageBase = {
  text: z.string().max(MAX_TEXT).optional(),
  /** The output the message is about. */
  output: outputRefSchema.optional(),
  /** The view open when it was sent, the `.view.json` format as `view.saved` holds it. */
  view: viewSchema
    .refine((v) => new TextEncoder().encode(JSON.stringify(v)).length <= MAX_VIEW_BYTES, {
      message: "the view is too large",
    })
    .optional(),
  /** The To check item this corrects. */
  toCheck: acceptToCheckRequestSchema.optional(),
};

/** `text` unless marks are attached (`markIds` in the request, `attached` in the stored payload). */
function messageRules<
  T extends z.ZodType<{ text?: string; attached?: unknown[]; markIds?: unknown[] }>,
>(schema: T) {
  return schema.refine(
    (m) =>
      (m.text !== undefined && m.text.trim() !== "") || (m.attached ?? m.markIds ?? []).length > 0,
    { path: ["text"], message: "text is required unless marks are attached" },
  );
}

/**
 * The payload of a `person.message` event (`events.ts`). `text` is required unless `attached` is
 * non-empty: marks alone may be all a message holds.
 */
export const personMessageSchema = messageRules(
  z.object({
    ...messageBase,
    /** The marks sent with the message, frozen from the log by the API at send time. */
    attached: z.array(attachedSchema).max(MAX_MARKS).optional(),
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

/** The request body: a `personMessageSchema` with the snapshot as base64 bytes, and the caller's retry id. */
export const sendRunMessageRequestSchema = messageRules(
  z.object({
    /** Kept across retries of the same message. */
    id: z.uuid(),
    ...messageBase,
    /** Marks already stored by `POST .../marks`; the API freezes them into `attached`. */
    markIds: z.array(z.uuid()).max(MAX_MARKS).optional(),
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

/**
 * The researcher answers a held call: `POST /api/review/runs/:runId/approvals/:requestId`, answered
 * 200 `{}`. `requestId` is the id of the `approval.requested` event (`<threadId>:approval:<toolCallId>`,
 * so encode it in the path). The API writes `approval.given` ("yes") or `approval.declined` ("no")
 * under the id `<request id>:answer`: the same answer twice is 200 with nothing written, a different one 409;
 * 404 for no open request. `text` is the researcher's words.
 */
export const answerApprovalRequestSchema = z.object({
  answer: z.enum(["yes", "no"]),
  text: z.string().max(MAX_TEXT).optional(),
});
export type AnswerApprovalRequest = z.infer<typeof answerApprovalRequestSchema>;
export const answerApprovalResponseSchema = z.object({});
