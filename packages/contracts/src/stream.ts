/**
 * Live traffic for the run screen, and the protocol between a browser and a
 * run's stream hub. Two kinds of traffic share one connection:
 *
 * - Durable events (`events.ts`) are stored and carry a `seq`.
 * - Live frames (here) are never stored and have no `seq`. They show a reply
 *   or a tool's output while it is happening; the durable events that follow
 *   (`message`, `tool.call`, `tool.result`) carry the same content and replace
 *   them. A lost frame costs nothing but a moment of liveness.
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
   * `toolCallId`: the reply that made the call is already a stored `message`
   * by the time the tool runs.
   */
  frame("tool.output", {
    toolCallId: toolCallIdSchema,
    stream: z.enum(["stdout", "stderr"]),
    text: z.string(),
  }),
]);
export type LiveFrame = z.infer<typeof liveFrameSchema>;

/** Browser → hub: the first message on the connection. */
export const subscribeSchema = z.object({
  type: z.literal("subscribe"),
  runId: runIdSchema,
  /** Cursor: the highest `seq` the browser already has, or -1 for none. */
  after: z.number().int().min(-1),
});
export type Subscribe = z.infer<typeof subscribeSchema>;

/** What the hub holds for one thread that is mid-reply or running a tool. */
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
 * 2. One `snapshot` of every thread's in-progress state. A durable event that
 *    arrives while the snapshot is built is sent after it, and a `message`
 *    event replaces the snapshot's partial with the same `messageId`.
 * 3. Then `frame` and new `event` messages interleaved, as they happen.
 *
 * A browser that disconnects subscribes again with its last `seq`. If the hub
 * restarts mid-reply the partial is lost, but the durable `message` still arrives.
 */
export const streamMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("event"), event: runEventSchema }),
  z.object({ type: z.literal("snapshot"), threads: z.array(threadSnapshotSchema) }),
  z.object({ type: z.literal("frame"), frame: liveFrameSchema }),
]);
export type StreamMessage = z.infer<typeof streamMessageSchema>;
