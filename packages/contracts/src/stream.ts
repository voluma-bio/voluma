/**
 * Live traffic for the run screen: what a browser reads from a run's stream
 * hub, and what the runner posts to it. Two kinds of traffic share one stream:
 *
 * - Durable events (`events.ts`) are stored and carry a `seq`.
 * - Live frames (here) are never stored and have no `seq`. They show a reply
 *   or a tool's output while it is happening; the durable events that follow
 *   carry the same content and replace them (rules on `streamMessageSchema`).
 *   A lost frame costs the rest of that reply's live view: the next delta no
 *   longer starts at the partial's length, so it is dropped (see `offset`) and
 *   the partial stays as it was until the durable event replaces it.
 *
 * Runner → hub: `POST /api/run/ingest/runs/:runId/live` with a `liveBatchSchema`
 * (`runner.ts`; lease token and fire-and-forget rules there). The rule that a
 * frame never outlives its durable event: the runner stops sending a reply's
 * or call's frames once it appends the event that replaces them, and a batch
 * that lands late is dropped by the rules below.
 *
 * Hub → browser: `GET /api/run/runs/:runId/stream`, a `text/event-stream`
 * (cookie-authenticated; the read is scoped like any run read, `run.ts`, so
 * another org's run is 404). Each SSE message's `data` is one
 * `streamMessageSchema` JSON. An `event` message carries the SSE `id:` equal to
 * its `seq`; `snapshot` and `frame` messages carry none, so frames never move
 * the resume point. The browser's cursor is the `id` of the last event it
 * has. On a reconnect `EventSource` sends it as `Last-Event-ID`; the first
 * connect may pass `?after=<seq>` instead (0 or absent for none; `seq` starts
 * at 1), and the header wins when both are present.
 */
import { z } from "zod";
import { runEventSchema } from "./events";
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
 * the reply. The runner picks it before streaming starts, so the hub can drop
 * a thread's partial when that event arrives. A thread streams one reply at a
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

/**
 * What the hub holds for one thread. Threads with nothing in progress are left
 * out, and so is a `message` with empty text and no tool arguments (a reply
 * that only calls tools has nothing to show until its arguments arrive).
 */
export const threadSnapshotSchema = z.object({
  threadId: nonEmpty,
  /** The reply so far; absent between replies. */
  message: z
    .object({
      messageId: nonEmpty,
      text: z.string(),
      /** Arguments so far, per tool call in that reply. */
      toolArguments: z.record(toolCallIdSchema, z.string()),
    })
    .optional(),
  /**
   * The most recent output chunks, oldest first, of tool calls that have no
   * `tool.result` yet. The hub bounds how much it keeps.
   */
  toolOutput: z.array(
    z.object({
      toolCallId: toolCallIdSchema,
      stream: z.enum(["stdout", "stderr"]),
      text: z.string(),
    }),
  ),
  /** True when the hub cut earlier output to stay within its bound. */
  toolOutputCut: z.boolean(),
});
export type ThreadSnapshot = z.infer<typeof threadSnapshotSchema>;

/**
 * The stream's messages, in order, on each connection:
 *
 * 1. One `snapshot` of every thread's in-progress state, taken when the
 *    connection opens. It includes every frame the hub received before then;
 *    those frames are never sent separately. It replaces all live state the
 *    browser holds, so partials from before a disconnect are discarded.
 * 2. `event` for every durable event with `seq > after`, oldest first, then
 *    new events as they happen. Events on one connection are in strictly
 *    increasing `seq` with no gap and no repeat: the hub holds back events that
 *    arrive while it reads the stored ones. So `Last-Event-ID` is always a
 *    cursor with nothing missing below it.
 * 3. `frame` messages as they happen, interleaved with the events in any order.
 *
 * The snapshot can hold a partial whose replacing event is among the stored
 * events the browser reads next; the clearing rules below take care of it.
 *
 * What the browser does with them (the hub applies the same rules to its own
 * state): the clearing and drop rules run on the snapshot against the events it
 * holds, and on every later event and frame. Every rule below is keyed by an
 * id, so order does not matter. Frames of one thread arrive in the order the runner sent them, and the drop
 * rules run before the others.
 * - Clearing: a `message` with `id === messageId` clears the partial text (tool
 *   arguments are not in a `message`; they stay until `tool.call`). A
 *   `thread.ended` with a `messageId` clears that reply's partial. A `tool.call`
 *   clears that call's `toolArguments`; a `tool.result` clears that call's
 *   output chunks.
 * - Dropping: a frame is dropped when its `messageId` already has a stored
 *   `message`, or its `toolCallId` already has a `tool.result`. A
 *   `tool.arguments.delta` is also dropped when its `toolCallId` already has a
 *   `tool.call`. A delta whose `offset` is not the length held is dropped; the
 *   partial then waits for the durable event.
 * - A delta with a new `messageId` on the thread discards the previous partial
 *   (one reply at a time). The runner writes a `message` for every reply that
 *   streamed, so only a crash, or a failed write of that event, leaves a
 *   partial with no ending event; the next reply or `thread.ended.messageId`
 *   ends it. `thread.started` and `thread.ended` clear nothing else: either can
 *   reach the hub after a later invocation's first frames.
 *
 * Because frames of a thread are ordered, a late frame can only belong to the
 * thread's latest reply and its recent calls: the hub needs to keep only each
 * thread's latest ids.
 *
 * If the hub restarts mid-reply the partial is lost, but the stored events still
 * arrive. A dropped connection needs no special handling: `EventSource`
 * reconnects with `Last-Event-ID`, and the new snapshot replaces the old live
 * state.
 */
export const streamMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("event"), event: runEventSchema }),
  z.object({ type: z.literal("snapshot"), threads: z.array(threadSnapshotSchema) }),
  z.object({ type: z.literal("frame"), frame: liveFrameSchema }),
]);
export type StreamMessage = z.infer<typeof streamMessageSchema>;
