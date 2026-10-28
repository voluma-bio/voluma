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
 * key is built. `compaction` is added when something produces it.
 *
 * `task`, `checkpoint` and `value` are what the run screen and the review are
 * folded from; the fold is specified below, after `taskStatusSchema`.
 */
import { z } from "zod";
import {
  relativePathSchema,
  runIdSchema,
  sha256Schema,
  taskIdSchema,
  toolCallIdSchema,
} from "./r2";
import { workflowPinSchema } from "./workflow";

const nonEmpty = z.string().min(1);

export const threadKindSchema = z.enum(["supervisor", "worker", "check", "chat"]);
export type ThreadKind = z.infer<typeof threadKindSchema>;

/** Checklist statuses (requirements, Vocabulary). */
export const taskStatusSchema = z.enum([
  "pending",
  "in-progress",
  "done",
  "failed",
  "to-check",
  "under-review",
  "stale",
]);
export type TaskStatus = z.infer<typeof taskStatusSchema>;

/**
 * A file the agent named, as recorded: copied to `evidenceKey(runId, sha256)`
 * before the event is appended, so a rerun can't erase it. `name` is its path
 * under the task's output folder (`outputKey`).
 */
export const evidenceRefSchema = z.object({ name: relativePathSchema, sha256: sha256Schema });
export type EvidenceRef = z.infer<typeof evidenceRefSchema>;

/**
 * THE FOLD: how the run screen and the review read `task`, `checkpoint` and
 * `value` events. Both lanes implement exactly this; nothing is summarised by a
 * model. Group by `payload.taskId`, in `seq` order. A task's *attempt* is the
 * events after its latest `task` event with status `in-progress` (or all of
 * them if there is none): a rerun starts a new attempt and the earlier events
 * stay in the record only.
 *
 * Run screen, per task:
 * - state: the latest `task` event's `status` and `reason`; `pending` if none.
 *   `by: "runtime"` marks a code decision (stuck guard, stale marking).
 * - milestones: the attempt's `checkpoint` texts in order, each with its
 *   evidence. One with a `verdict` is the check line (the second agent's
 *   result). One with `toCheck` also counts toward the "N to check" badge.
 * - outputs: the attempt's `value` events, the latest per `measurementId`.
 *
 * Review, a `ReviewTask` per task per attempt (the revision's id, label and
 * which attempt it holds are the API's, not events'):
 * - measurements: each output above becomes a `Measurement`. `id`, `title`,
 *   `value`, `unit`, `confidence`, `note`, `definition`, `structureIds`,
 *   `annotationIds`, `numeratorId`, `denominatorId` are copied; `source` is the
 *   event's `{threadId, id}`; `evidenceIds` are the sha256 of its evidence
 *   files; `references` is empty (no agent supplies other readers' values).
 * - evidence: the attempt's checkpoint and value evidence files, unique by
 *   sha256, as `Asset { id: sha256, name, stage: task title, key:
 *   evidenceKey(runId, sha256), sha256 }`.
 * - checker: the latest checkpoint with a `verdict` → `{verdict, text}`; null
 *   if none.
 * - checks: each checkpoint with `toCheck` → `{id: event id, title:
 *   toCheck.title, detail: text, status: "open"}`. Accepting one is the
 *   reviewer's action, stored by the review lane, not an event here.
 * - threads: `worker` is the `threadId` of the attempt's events from a worker
 *   thread, `check` from a check thread (`thread.started.task` names a check's
 *   task); `chat` comes from the review lane.
 * - `files` (downloads) and `structureIds` on the task are not from these
 *   events: the API lists the task's output folder, the workflow declares the
 *   structures. A `structureIds`/`annotationIds` entry the revision doesn't
 *   contain is dropped (the revision validates ids).
 */

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

  /**
   * A checklist task changed status. Written by the runtime when a `checklist`
   * tool call succeeds (`task-tools.ts`), or by the runtime's own code: the
   * envelope `threadId` is the thread whose tool or wake produced it, and `by`
   * tells a tool call (`agent`) from code the runtime ran itself (`runtime`).
   */
  const task = event(
    "task",
    z.object({
      taskId: taskIdSchema,
      status: taskStatusSchema,
      /** One plain-language line: why, shown beside the state. */
      reason: nonEmpty,
      by: z.enum(["agent", "runtime"]),
    }),
  );

  /**
   * A milestone under a task, in the mockup's progress-line style. From a
   * worker or check thread's `checkpoint` tool, or the runtime when it flags
   * unfinished work (then the thread is the supervisor, which has no such tool).
   */
  const checkpoint = event(
    "checkpoint",
    z.object({
      taskId: taskIdSchema,
      text: nonEmpty,
      evidence: z.array(evidenceRefSchema),
      /** The check thread's verdict line; only check threads may set it. */
      verdict: z.enum(["passed", "needs-review"]).optional(),
      /** Raises a To check item: `text` is its detail. */
      toCheck: z.object({ title: nonEmpty }).optional(),
    }),
  );

  /**
   * A measurement from `report_value`. A rerun or fix reports the same
   * `measurementId` again and replaces it.
   */
  const value = event(
    "value",
    z.object({
      taskId: taskIdSchema,
      /** Stable across reruns of the task: the agent's name for the quantity, e.g. `femur-width`. */
      measurementId: nonEmpty,
      title: nonEmpty,
      /** Null when it could not be computed; say why in `note`. */
      value: z.number().finite().nullable(),
      unit: nonEmpty,
      confidence: z.enum(["provisional", "candidate"]).nullable(),
      note: z.string().optional(),
      definition: z.string().optional(),
      evidence: z.array(evidenceRefSchema),
      structureIds: z.array(nonEmpty),
      annotationIds: z.array(nonEmpty),
      /** Ratios: the `measurementId`s divided. */
      numeratorId: nonEmpty.optional(),
      denominatorId: nonEmpty.optional(),
    }),
  );

  return z.discriminatedUnion("type", [
    threadStarted,
    threadEnded,
    message,
    toolCall,
    toolResult,
    sandbox,
    task,
    checkpoint,
    value,
  ]);
};

/** What a client appends: an event without `seq`. */
export const eventInputSchema = eventUnion({});
export type EventInput = z.infer<typeof eventInputSchema>;

/** A stored event, with its server-assigned `seq`. */
export const runEventSchema = eventUnion({ seq: z.number().int().nonnegative() });
export type RunEvent = z.infer<typeof runEventSchema>;
export type EventType = RunEvent["type"];
