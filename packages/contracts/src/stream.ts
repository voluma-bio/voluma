/**
 * The browser's run stream: `GET /api/run/runs/:runId/stream`, a
 * `text/event-stream` (cookie-authenticated; the read is scoped like any run
 * read, `run.ts`, so another org's run is 404). It carries durable events only
 * (`events.ts`): each SSE message's `data` is one `runEventSchema` JSON and its
 * `id:` is the event's `seq`. There is no snapshot on connect.
 *
 * The browser's cursor is the `id` of the last event it has. On a reconnect
 * `EventSource` sends it as `Last-Event-ID`; the first connect may pass
 * `?after=<seq>` instead (0 or absent for none; `seq` starts at 1), and the
 * header wins when both are present. The hub sends every stored event with
 * `seq > after`, oldest first, then new events as they happen. Events on one
 * connection are in strictly increasing `seq` with no gap and no repeat: the
 * hub holds back events that arrive while it reads the stored ones. So
 * `Last-Event-ID` is always a cursor with nothing missing below it, and the
 * browser needs no dedupe.
 *
 * The stream has an end. Once the run has ended and the hub has sent every stored event,
 * it sends one `event: end` message (`END_EVENT`; its `data` means nothing) and closes the
 * response, also when nothing is left after the cursor (a request for an ended run is
 * answered 200 with `end` alone). The browser closes its `EventSource` on it: the log it
 * holds is whole. Without that, `EventSource` would take the close for a drop and
 * reconnect after its retry delay (about 3 s). A non-200 status (404, 401) or a
 * non-`text/event-stream` response stops it for good. The browser sees that as
 * `readyState === CLOSED` and can then refetch the run, or call `getMe` to tell a
 * sign-out from an ended run.
 *
 * Live frames (`liveFrameSchema` below) ride the same response as a *named* SSE event,
 * `event: live`, `data:` one frame's JSON, and never an `id:` line, so `Last-Event-ID` stays
 * the durable `seq`. They are the model's output as it is written (text, reasoning, tool
 * arguments, tool output), are not stored and have no `seq`, and are sent only to streams
 * open when they arrive: a reconnect or reload does not replay them, and a reply that was
 * mid-stream then appears only when its durable `message` event does. Frames are best
 * effort, so a client drops a frame that does not fit (see `offset`) and treats the
 * durable event as the record.
 */
import { z } from "zod";
import { runIdSchema, toolCallIdSchema } from "./ids";

const nonEmpty = z.string().min(1);
const nonNegInt = z.number().int().nonnegative();

/**
 * `offset` is the index in `text`'s accumulated string (UTF-16 code units, as
 * JS counts) where this delta starts; the first delta of a reply or a call is
 * 0. The browser appends a delta only when its `offset` equals the
 * length they hold, so a lost, repeated or reordered frame is dropped instead
 * of corrupting the partial.
 *
 * `messageId` is the `id` of the durable `message` event that will complete
 * the reply, picked before streaming starts. A thread streams one reply at a
 * time. A frame's text is appended to what the client holds for its key; the durable
 * `message` event with that `messageId` replaces the partial (its `text` and `reasoning` are
 * the final strings).
 */
const frame = <T extends string, P extends z.ZodRawShape>(type: T, payload: P) =>
  z.object({ type: z.literal(type), runId: runIdSchema, threadId: nonEmpty, ...payload });

export const liveFrameSchema = z.discriminatedUnion("type", [
  /** More of the reply's text. */
  frame("text.delta", { messageId: nonEmpty, offset: nonNegInt, text: z.string() }),
  /**
   * More of the reply's reasoning (the model's thinking), as one string per reply: the
   * provider's thinking text as it streams, with `offset` counting across thinking blocks.
   * Providers add their own separators, so the deltas can differ in whitespace from the
   * durable `message`'s `reasoning` (the blocks joined with a blank line), which replaces them.
   */
  frame("reasoning.delta", { messageId: nonEmpty, offset: nonNegInt, text: z.string() }),
  /** More of a tool call's JSON arguments, as the model writes them. */
  frame("tool.arguments.delta", {
    messageId: nonEmpty,
    toolCallId: toolCallIdSchema,
    offset: nonNegInt,
    text: z.string(),
  }),
  /**
   * A chunk of output while a tool runs. Chunks are coalesced and best effort:
   * never rebuild a result from them. `tool.result` is the record. Keyed by
   * `toolCallId`, not `messageId`: a tool runs after its reply has ended, and
   * its output belongs to the call, not the reply.
   */
  frame("tool.output", {
    toolCallId: toolCallIdSchema,
    stream: z.enum(["stdout", "stderr"]),
    text: z.string(),
  }),
]);
/** The SSE event name that carries a `LiveFrame`. */
export const LIVE_EVENT = "live";
/** The SSE event name that ends an ended run's stream: every stored event has been sent. */
export const END_EVENT = "end";
export type LiveFrame = z.infer<typeof liveFrameSchema>;
