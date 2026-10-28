/**
 * Live traffic for the run screen, and the protocol between a browser and a
 * run's stream hub. Two kinds of traffic share one connection:
 *
 * - Durable events (`events.ts`) are stored and carry a `seq`.
 * - Live frames (here) are never stored and have no `seq`. They show a reply
 *   or a tool's output while it is happening; the durable events that follow
 *   carry the same content and replace them (rules on `streamMessageSchema`).
 *   A lost frame costs nothing but a moment of liveness.
 *
 * The runner sends frames to the hub (`liveFrameSchema`); the hub forwards
 * them to subscribed browsers (`streamMessageSchema`).
 */
import { z } from "zod";
import { runEventSchema } from "./events";
import { runIdSchema, toolCallIdSchema } from "./r2";

const nonEmpty = z.string().min(1);

/**
 * `messageId` is the `id` of the durable `message` event that will complete
 * the reply. The runner picks it before streaming starts, so the hub can drop
 * a thread's partial when that event arrives. A thread streams one reply at a
 * time. No thinking text is streamed.
 */
const frame = <T extends string, P extends z.ZodRawShape>(type: T, payload: P) =>
  z.object({ type: z.literal(type), runId: runIdSchema, threadId: nonEmpty, ...payload });

export const liveFrameSchema = z.discriminatedUnion("type", [
  /** More of the reply's text. */
  frame("text.delta", { messageId: nonEmpty, text: z.string() }),
  /** More of a tool call's JSON arguments, as the model writes them. */
  frame("tool.arguments.delta", {
    messageId: nonEmpty,
    toolCallId: toolCallIdSchema,
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
 * Browser → hub: the first message on the connection, sent once. The hub is
 * addressed per run, so `runId` only has to match it; a mismatch is rejected.
 */
export const subscribeSchema = z.object({
  type: z.literal("subscribe"),
  runId: runIdSchema,
  /** Cursor: the highest `seq` the browser already has, or -1 for none. */
  after: z.number().int().min(-1),
});
export type Subscribe = z.infer<typeof subscribeSchema>;

/** What the hub holds for one thread. Threads with nothing in progress are left out. */
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
  /** The most recent output chunks, oldest first, of tool calls that have no `tool.result` yet. */
  toolOutput: z.array(
    z.object({
      toolCallId: toolCallIdSchema,
      stream: z.enum(["stdout", "stderr"]),
      text: z.string(),
    }),
  ),
});
export type ThreadSnapshot = z.infer<typeof threadSnapshotSchema>;

/**
 * Hub → browser. After `subscribe`, the hub sends, in order:
 *
 * 1. `event` for every durable event with `seq > after`, oldest first.
 * 2. One `snapshot` of every thread's in-progress state. It replaces all live
 *    state the browser holds, so partials from before a disconnect are discarded.
 * 3. Then `frame` and new `event` messages as they happen.
 *
 * The hub reads stored events asynchronously while live ones keep arriving, so
 * it may send an event twice but never skips one. The browser ignores an
 * `event` whose `seq` it already has.
 *
 * Frames and events travel by separate paths and can arrive in either order,
 * so browser and hub apply the same rules to the live state of a thread:
 * - A `message` with `id === messageId` clears the partial text. (Tool
 *   arguments are not in a `message`; they stay until `tool.call`.)
 * - A `tool.call` clears that call's `toolArguments`; a `tool.result` clears
 *   that call's output chunks.
 * - A frame for a `messageId` that already has a stored `message`, or a
 *   `toolCallId` that already has a `tool.result`, is dropped.
 * - A delta with a new `messageId` on the thread discards the previous
 *   partial (one reply at a time). `thread.started` and `thread.ended` clear
 *   everything held for the thread. A reply with no text, one that failed, or
 *   one cut off by a crash never gets a `message`; these rules end its partial.
 *
 * If the hub restarts mid-reply the partial is lost, but the stored events still arrive.
 */
export const streamMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("event"), event: runEventSchema }),
  z.object({ type: z.literal("snapshot"), threads: z.array(threadSnapshotSchema) }),
  z.object({ type: z.literal("frame"), frame: liveFrameSchema }),
]);
export type StreamMessage = z.infer<typeof streamMessageSchema>;
