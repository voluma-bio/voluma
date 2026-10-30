/**
 * Corrections: a researcher talks with a finished run's main agent from the 3D panel, and the
 * agent redoes a task on "go". The design is `iterate-and-review/design/corrections.md`.
 *
 *   POST /api/review/runs/:runId/messages   body `sendRunMessageRequestSchema` → 200 `sendRunMessageResponseSchema`
 *
 * The route appends one server-authored `person.message` event (`events.ts`) and, if the run
 * has ended `completed` or is `awaiting-person`, moves it to `queued`; a runner claims it with
 * `claim.started.after` `person-message` and resumes the main agent with the message. A message
 * to a `running` or `queued` run only appends: the runner delivers it to the main thread. The
 * main agent answers with its `reply` tool, which writes a `reply` event. The panel reads
 * the chat with `conversation(events)` (`conversation.ts`) from the run's event stream, the
 * same `GET /api/run/runs/:id/stream` frames the run page folds (`stream.ts`); it needs no
 * route of its own.
 *
 * Who may send: anyone who may read the run (the same shared review state as `acceptCheck`;
 * `review.ts`). Cookie auth and Origin rules are `run.ts`'s.
 * Only this route's body limit is raised, to `MESSAGE_BODY_BYTES`; the snapshot is at most
 * `MAX_MESSAGE_SNAPSHOT_BYTES` after decoding, and the server checks the decoded size and
 * the PNG signature, not only the string.
 *
 * Idempotent: the caller keeps `id` across retries. The event id is `<runId>.person:<id>`; a
 * retry with the same `id` stores nothing new and answers 200 with the original event id and the
 * run's current state. The server stamps `createdAt`.
 *
 * Refusals. 400: invalid body; 404: unknown or unreadable run, or a `taskId` the run has no
 * plan for; 403: a read-only example run, or a `visitor` run (its keys are not kept, so a
 * reopened run could not be resumed; out of scope for now); 409: the run ended `failed` or
 * `cancelled` (only a run that ended `completed` has a coherent state to talk about and redo
 * from: a failed or cancelled run's threads were ended or cut, so it is rerun, not reopened),
 * or has no plan yet; 413: over the body or snapshot limit; 415: the snapshot is not a PNG;
 * 503: no file storage for the snapshot. Not refused: a `running` or `queued` run.
 *
 * Idle end. A run released `awaiting-person` with no person message for
 * `AWAITING_PERSON_IDLE_MINUTES` is ended as it was, by an API-side sweep (no runner holds
 * it): the root thread's end is written unchanged (the `finish_run` outcome and summary of
 * the run's last end). No-progress limit (`runner.ts`): an `awaiting-person` release is not a
 * counted reason and does not reset the count, and appending a `person.message` resets the run's
 * stalled-claim count to 0 (the API does it as it appends; the event is written between claims, so
 * no claim's progress window ever contains it).
 */
import { z } from "zod";
import { taskIdSchema } from "./ids";
import { sha256Schema } from "./r2";
import { voxelBoxSchema, voxelIndexSchema } from "./review";
import { runStateSchema } from "./run";

/** How long an `awaiting-person` run waits for a person message before the API ends it. */
export const AWAITING_PERSON_IDLE_MINUTES = 30;

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

/** The PNG of the researcher's view, kept as evidence at `evidenceKey(runId, sha256)`; read it with `reviewFileUrl`. */
export const messageSnapshotRefSchema = z.object({
  mimeType: z.literal("image/png"),
  sha256: sha256Schema,
});
export type MessageSnapshotRef = z.infer<typeof messageSnapshotRefSchema>;

/**
 * The payload of a `person.message` event (`events.ts`). `text` is required unless `go`: the Go
 * button may send nothing else. `taskId` is the task the panel was showing, a hint for the
 * agent. `go` tells the main agent it may now act on the task (code enforces it, `corrections.md`).
 */
export const personMessageSchema = z
  .object({
    text: z.string().max(MAX_TEXT).optional(),
    marks: z.array(markSchema).max(MAX_MARKS).optional(),
    snapshot: messageSnapshotRefSchema.optional(),
    taskId: taskIdSchema.optional(),
    go: z.literal(true).optional(),
  })
  .refine((m) => m.go === true || (m.text !== undefined && m.text.trim() !== ""), {
    path: ["text"],
    message: "text is required unless go",
  });
export type PersonMessage = z.infer<typeof personMessageSchema>;

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
  });
export type SendRunMessageRequest = z.infer<typeof sendRunMessageRequestSchema>;

export const sendRunMessageResponseSchema = z.object({
  /** The stored `person.message` event. */
  eventId: z.string().min(1),
  /** The run's state after the message: `queued` for a run that was reopened. */
  state: runStateSchema,
});
export type SendRunMessageResponse = z.infer<typeof sendRunMessageResponseSchema>;
