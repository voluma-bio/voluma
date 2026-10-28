/**
 * The run event log: what an agent thread did, in order. The envelope is the
 * same for every kind; `type` selects the payload. The runner appends events
 * (`eventInputSchema`; `id` is chosen by the client so a retried POST is a
 * no-op); the server stamps `seq`, unique and increasing per run, which is
 * also the stream cursor the UI resumes from.
 *
 * These are the durable events. Live output (text and tool deltas, tool output
 * chunks) is not stored and has no `seq`: see `stream.ts`.
 *
 * Ids that become R2 key segments (`runId`, `task`, `toolCallId`) are checked
 * with the `r2.ts` schemas here, so an accepted event can't fail later when a
 * key is built. v0 kinds only. `task`, `value` and `compaction` are added when something
 * produces them.
 */
import { z } from "zod";
import { runIdSchema, taskIdSchema, toolCallIdSchema } from "./r2";
import { workflowPinSchema } from "./workflow";

const nonEmpty = z.string().min(1);

export const threadKindSchema = z.enum(["supervisor", "worker", "check", "chat"]);
export type ThreadKind = z.infer<typeof threadKindSchema>;

const envelope = {
  /** Chosen by the client; appending the same id twice stores one event. */
  id: nonEmpty,
  runId: runIdSchema,
  threadId: nonEmpty,
  createdAt: z.iso.datetime(),
};

/** The union of all kinds; `extra` adds fields to every envelope. */
const eventUnion = <S extends z.ZodRawShape>(extra: S) => {
  const event = <T extends string, P extends z.ZodType>(type: T, payload: P) =>
    z.object({ ...envelope, ...extra, type: z.literal(type), payload });

  /**
   * A thread has one `thread.started` per invocation: the first run and each
   * resume after a restart. The latest one with no `thread.ended` after it
   * means the thread is running.
   */
  const threadStarted = event(
    "thread.started",
    z.object({
      /** Null on a run's root thread. */
      parentThreadId: z.string().nullable(),
      kind: threadKindSchema,
      task: taskIdSchema.optional(),
      /** The tool call in the parent thread that started this thread. */
      spawnedBy: nonEmpty.optional(),
      /** Workflow packages the run is pinned to; set on the root thread only. */
      workflows: z.array(workflowPinSchema).optional(),
    }),
  );

  const threadEnded = event(
    "thread.ended",
    z.object({
      status: z.enum(["completed", "failed", "cancelled"]),
      error: z.string().optional(),
      /**
       * The reply that was streaming when the invocation was cut off, if its
       * `message` was never written. It ends that reply's live partial
       * (`stream.ts`), so every clearing rule stays keyed by an id.
       */
      messageId: nonEmpty.optional(),
    }),
  );

  /**
   * Replaces the live partial text whose `messageId` equals this event's `id`
   * (`stream.ts`). The runner writes one for every assistant reply that
   * streamed, including an empty or failed one. A tool call is a separate
   * event; the `message` of a reply that only calls tools has empty text.
   */
  const message = event(
    "message",
    z.discriminatedUnion("role", [
      z.object({
        role: z.literal("user"),
        text: z.string(),
        /**
         * Who sent it: another thread's `thread_message` (`thread-message.ts`),
         * the runtime (the restart note), or a person.
         */
        sender: z.discriminatedUnion("kind", [
          z.object({ kind: z.literal("thread"), threadId: nonEmpty }),
          z.object({ kind: z.literal("runtime") }),
          z.object({ kind: z.literal("person") }),
        ]),
      }),
      z.object({ role: z.literal("assistant"), text: z.string() }),
      z.object({ role: z.literal("system"), text: z.string() }),
    ]),
  );

  const toolCall = event(
    "tool.call",
    z.object({ toolCallId: toolCallIdSchema, name: nonEmpty, input: z.unknown() }),
  );

  /**
   * Authoritative end of a tool call. Live output while it ran was never
   * stored (`stream.ts`); this and `toolOutputKey` are the record.
   */
  const toolResult = event(
    "tool.result",
    z.object({
      toolCallId: toolCallIdSchema,
      isError: z.boolean(),
      /** What the model saw: head and tail only when `truncated`. */
      output: z.string(),
      /** When true the full output is at `toolOutputKey(runId, toolCallId)`. */
      truncated: z.boolean(),
    }),
  );

  /**
   * Sandbox lifecycle, written by the runner under the thread whose tool call
   * needed the sandbox. The sandbox is created on first use, once per run.
   */
  const sandbox = event(
    "sandbox",
    z.object({
      name: nonEmpty,
      state: z.enum(["starting", "ready", "stopped", "failed"]),
      detail: z.string().optional(),
    }),
  );

  return z.discriminatedUnion("type", [
    threadStarted,
    threadEnded,
    message,
    toolCall,
    toolResult,
    sandbox,
  ]);
};

/** What a client appends: an event without `seq`. */
export const eventInputSchema = eventUnion({});
export type EventInput = z.infer<typeof eventInputSchema>;

/** A stored event, with its server-assigned `seq`. */
export const runEventSchema = eventUnion({ seq: z.number().int().nonnegative() });
export type RunEvent = z.infer<typeof runEventSchema>;
export type EventType = RunEvent["type"];
