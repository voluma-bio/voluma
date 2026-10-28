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
 * it closes the response; a request for an ended run with nothing after the cursor is
 * answered 204, which stops `EventSource` for good (it reconnects after any other close).
 * A non-200 status or a non-`text/event-stream` response also stops it. The browser sees
 * that as `readyState === CLOSED` and can then refetch the run, or call `getMe` to tell a
 * sign-out from an ended run.
 *
 * Reserved, not served yet: `liveFrameSchema` below is the shape of token-by-token
 * streaming (text and tool-argument deltas, tool output chunks) for the review
 * chat. No route carries it.
 */
import { z } from "zod";
import { runIdSchema, toolCallIdSchema } from "./ids";

const nonEmpty = z.string().min(1);
const nonNegInt = z.number().int().nonnegative();

/**
 * `offset` is the index in `text`'s accumulated string (UTF-16 code units, as
 * JS counts) where this delta starts; the first delta of a reply or a call is
 * 0. The hub and the browser append a delta only when its `offset` equals the
 * length they hold, so a lost, repeated or reordered frame is dropped instead
 * of corrupting the partial.
 *
 * `messageId` is the `id` of the durable `message` event that will complete
 * the reply, picked before streaming starts. A thread streams one reply at a
 * time. No thinking text is streamed.
 */
const frame = <T extends string, P extends z.ZodRawShape>(type: T, payload: P) =>
  z.object({ type: z.literal(type), runId: runIdSchema, threadId: nonEmpty, ...payload });

export const liveFrameSchema = z.discriminatedUnion("type", [
  /** More of the reply's text. */
  frame("text.delta", { messageId: nonEmpty, offset: nonNegInt, text: z.string() }),
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
export type LiveFrame = z.infer<typeof liveFrameSchema>;
