/**
 * The run event log: what an agent thread did, in order. The envelope is the
 * same for every kind; `type` selects the payload. The runner appends events
 * (`eventInputSchema`; `id` is chosen by the client so a retried POST is a
 * no-op); the server stamps `seq`, unique and increasing per run, which is
 * also the stream cursor the UI resumes from.
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
    }),
  );

  const message = event(
    "message",
    z.object({
      role: z.enum(["system", "user", "assistant"]),
      text: z.string(),
    }),
  );

  const toolCall = event(
    "tool.call",
    z.object({ toolCallId: toolCallIdSchema, name: nonEmpty, input: z.unknown() }),
  );

  /**
   * Live output while a tool runs. Best effort: chunks are coalesced and may be
   * dropped, so never rebuild a result from them; `tool.result` is the record.
   */
  const toolOutput = event(
    "tool.output",
    z.object({
      toolCallId: toolCallIdSchema,
      stream: z.enum(["stdout", "stderr"]),
      text: z.string(),
    }),
  );

  /** Authoritative end of a tool call. */
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
   * Sandbox lifecycle, written by the sandbox's Durable Object under the
   * thread whose exec request caused it (requests carry the calling
   * `threadId`), with an id from `crypto.randomUUID()`. Every event has a thread.
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
    toolOutput,
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
