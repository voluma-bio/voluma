/**
 * Live traffic for the run screen, and the protocol between a browser and a
 * run's stream hub. Two kinds of traffic share one connection:
 *
 * - Durable events (`events.ts`) are stored and carry a `seq`.
 * - Live frames (here) are never stored and have no `seq`. They show a reply
 *   or a tool's output while it is happening; the durable events that follow
 *   carry the same content and replace them (rules on `streamMessageSchema`).
 *   A lost frame costs the rest of that reply's live view: the next delta no
 *   longer starts at the partial's length, so it is dropped (see `offset`) and
 *   the partial stays as it was until the durable event replaces it.
 *
 * The runner sends frames to the hub (`liveFrameSchema`); the hub forwards
 * them to subscribed browsers (`streamMessageSchema`).
 */
import { z } from "zod";
import { runEventSchema } from "./events";
import { runIdSchema, toolCallIdSchema } from "./r2";

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

/** Browser → hub: the first message on the connection, sent once. The hub is addressed per run. */
export const subscribeSchema = z.object({
  type: z.literal("subscribe"),
  /** Cursor: the highest `seq` the browser already has, or 0 for none (`seq` starts at 1). */
  after: nonNegInt,
});
export type Subscribe = z.infer<typeof subscribeSchema>;

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
 * Hub → browser. After `subscribe`, the hub sends, in order:
 *
 * 1. `event` for every durable event with `seq > after`, oldest first.
 * 2. One `snapshot` of every thread's in-progress state. It is taken when it
 *    is sent and includes every frame the hub received before then; those
 *    frames are never sent separately.
 * 3. Then `frame` and new `event` messages as they happen.
 *
 * Events and frames may arrive in any order, and an event may arrive twice.
 * `seq` is gapless per run, so the browser's cursor is the highest `seq` it
 * holds with no gap below it. If it sees a gap, it resubscribes from that
 * cursor. The hub reads stored events asynchronously while live ones keep
 * arriving, so it may send an event twice but never skips one.
 *
 * What the browser must do (the hub applies the same rules to its own state):
 * - An `event` whose `seq` it already holds is not appended again, but still
 *   runs through the clearing rules below.
 * - A `snapshot` replaces all live state it holds, so partials from before a
 *   disconnect are discarded. The clearing and drop rules then run on the
 *   snapshot against the events it holds, because the hub may not have seen an
 *   event yet that the browser read in step 1.
 *
 * Every rule below is keyed by an id, so order does not matter. Frames of one
 * thread arrive in the order the runner sent them, and the drop rules run
 * before the others.
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
 * If the hub restarts mid-reply the partial is lost, but the stored events still arrive.
 */
export const streamMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("event"), event: runEventSchema }),
  z.object({ type: z.literal("snapshot"), threads: z.array(threadSnapshotSchema) }),
  z.object({ type: z.literal("frame"), frame: liveFrameSchema }),
]);
export type StreamMessage = z.infer<typeof streamMessageSchema>;
