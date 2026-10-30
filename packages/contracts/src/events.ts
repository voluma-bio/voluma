/**
 * The run event log: agent activity and human review decisions, in order. The envelope is the
 * same for every kind; `type` selects the payload. The runner appends events
 * (`eventInputSchema`; `id` is chosen by the client so a retried POST is a
 * no-op, and the POST carries the run's lease token, `LEASE_TOKEN_HEADER` in
 * `runner.ts`, whose 409 means the runner stops); the server stamps `seq`,
 * unique and increasing per run, which is also the stream cursor the UI
 * resumes from.
 *
 * Reading back (the runner, to resume a run it claimed):
 *   GET /api/run/ingest/runs/:runId/events?after=<seq>  → 200 `runEventsResponseSchema`
 * with the lease token like every ingest call (`runner.ts`); a stale token is a
 * 409 whose body is `leaseLostSchema`, and the runner stops. It returns the
 * run's events with `seq > after` (0 or absent for all; `seq` starts at 1) in
 * `seq` order, at most 1000; `more` says another page follows, read by passing
 * the last `seq` as `after`. A stored event the runner can't parse fails the
 * resume: skipping it would shift every later `seq`. The runner reads them all before it
 * decides anything, so its view is the stored log.
 *
 * These are the durable events. Live output (text and tool deltas, tool output
 * chunks) is not stored and has no `seq`; the run stream carries it as live frames: see `stream.ts`.
 *
 * Ids that become R2 key segments (`runId`, `taskId`, `toolCallId`, evidence paths) are checked
 * with the `r2.ts` schemas here, so an accepted event can't fail later when a
 * key is built. `compaction` is added when something produces it.
 *
 * `task`, `checkpoint` and `output` are what the run screen and the review are
 * folded from (see below).
 * `check.accepted` and `review.completed` are server-authored human decisions:
 * readable in runEventSchema, rejected by the runner's eventInputSchema, and ignored
 * by the scientific fold. Their payloads and command rules live in review.ts.
 * `person.message`, `run.reopened` and `correction.ended` are server-authored correction events
 * on thread `<runId>.person`, handled the same way (payloads, ids and rules in messages.ts).
 * `reply` is the main agent's side of the chat: the runner writes it from the `reply` tool on the
 * main thread. The fold ignores all four; `conversation` (conversation.ts) reads the chat.
 */
import { z } from "zod";
import {
  modelRefSchema,
  runIdSchema,
  taskIdSchema,
  taskStatusSchema,
  toolCallIdSchema,
} from "./ids";
import {
  correctionEndedSchema,
  personMessageSchema,
  replySchema,
  runReopenedSchema,
} from "./messages";
import { evidenceRefSchema, outputReportSchema } from "./output";
import { sha256Schema } from "./r2";
import {
  checkAcceptedSchema,
  focusSchema,
  reviewAssetsManifestSchema,
  reviewCompletedSchema,
} from "./review";
import { claimEndReasonSchema } from "./runner";
import { planTaskSchema, recordedPinSchema, workflowPlanSchema } from "./workflow";

const nonEmpty = z.string().min(1);

/** The bound on an `assets.failed` error, in UTF-16 code units. */
export const ASSET_ERROR_MAX = 1000;

/**
 * What one model call used, as Pi reports it: `input` is the uncached input tokens only, so
 * the prompt was `input + cacheRead + cacheWrite` tokens and the cache hit share is
 * `cacheRead / (input + cacheRead)`. A call with `cacheRead === 0` was cold. `costUsd` is
 * Pi's total cost for the call. Absent on events written before this field existed.
 */
export const modelUsageSchema = z.object({
  input: z.number().int().nonnegative(),
  output: z.number().int().nonnegative(),
  cacheRead: z.number().int().nonnegative(),
  cacheWrite: z.number().int().nonnegative(),
  /** Reasoning tokens, when the provider reports them (already counted in `output`). */
  reasoning: z.number().int().nonnegative().optional(),
  costUsd: z.number().nonnegative(),
});
export type ModelUsage = z.infer<typeof modelUsageSchema>;

export const threadKindSchema = z.enum(["supervisor", "main", "worker", "check", "chat"]);
export type ThreadKind = z.infer<typeof threadKindSchema>;

/** Who made a decision: a tool call or a named runtime rule (`task-tools.ts`). */
export const bySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("agent") }),
  z.object({
    kind: z.literal("rule"),
    rule: z.enum([
      "stuck",
      "stale",
      "check-start",
      "check-result",
      // A check hit its time or ask limit; a task reached its fix-round limit.
      "check-limit",
      "fix-limit",
      // The main agent stopped with work unfinished and code ended it.
      "liveness",
    ]),
  }),
]);
export type By = z.infer<typeof bySchema>;

/**
 * THE FOLD is the function `fold` in `fold.ts`: the one spec the run screen,
 * the runtime's per-task record and the review all call. The runtime
 * guarantees the event rules in `task-tools.ts`.
 *
 * Two runtime-owned markers carry the structure; nothing is inferred from the
 * order of status events:
 * - `revision.started` opens a revision at a point in the log. Revision *k* is
 *   the fold of every event before revision *k+1* starts.
 * - `attempt.opened` opens a work attempt on a task. Its id is that event's
 *   id; the runtime stamps it as `attemptId` on the `task`, `checkpoint` and
 *   `output` events that belong to it.
 */

const envelope = {
  /** Chosen by the writer (runner or API); appending the same id twice stores one event. */
  id: nonEmpty,
  runId: runIdSchema,
  threadId: nonEmpty,
  createdAt: z.iso.datetime(),
};

/** Runner-authored kinds only; `extra` adds fields to every envelope. */
const eventUnion = <S extends z.ZodRawShape>(extra: S) => {
  const event = <T extends string, P extends z.ZodType>(type: T, payload: P) =>
    z.object({ ...envelope, ...extra, type: z.literal(type), payload });

  /**
   * Who sent a user message: another thread's tool (the main agent's `message`),
   * the runtime (the restart note), or a person.
   */
  const userSender = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("thread"), threadId: nonEmpty }),
    z.object({
      kind: z.literal("runtime"),
      /**
       * On a delivery to the main agent: the id of the last log event the delivery
       * accounted for, so what follows it is undelivered. Optional; `fold` ignores it.
       */
      covers: nonEmpty.optional(),
    }),
    z.object({ kind: z.literal("person") }),
  ]);

  /**
   * A thread has one `thread.started` per invocation: the first run and each
   * resume after a restart. The latest one with no `thread.ended` after it
   * means the thread is running.
   */
  const threadStarted = event(
    "thread.started",
    z
      .object({
        /** Null on a run's root thread. */
        parentThreadId: z.string().nullable(),
        kind: threadKindSchema,
        /** The task a worker or check thread works on; required for those, absent on the supervisor and the main agent. */
        task: taskIdSchema.optional(),
        /** The attempt a check thread checks; set on check threads only. */
        attemptId: nonEmpty.optional(),
        /** The tool call in the parent thread that started this thread. */
        spawnedBy: nonEmpty.optional(),
        /** The workflow files the run ran, with the commit the runner's checkout was at; required on the root thread; child threads may omit it. */
        workflows: z.array(recordedPinSchema).min(1).optional(),
        /**
         * The model this thread calls, as the runner names it: `provider/id`
         * (`meta/muse-spark-1.3`). Main, worker, check and chat threads call one and
         * should set it. The supervisor thread sets none: it runs no model (the `main` thread,
         * its child, is the run's main agent). A thread's model is
         * fixed for its life: every `thread.started` of a thread names the same one, and
         * the harness fails a resume on a different model, as it does for a differing
         * system prompt. Optional in the schema until the harness writes it; then it
         * becomes required on those kinds.
         */
        model: modelRefSchema.optional(),
        /**
         * The user message a resume starts with (an answer, feedback, a delivery, a nudge),
         * stored with the start because the thread's own `message` event comes only after it
         * loads its history. A start with no user message after it was cut off before it got
         * its input, and the next claim resumes it with this. Absent on a thread's first start.
         */
        input: z.object({ text: z.string(), sender: userSender }).optional(),
      })
      .refine((p) => p.parentThreadId !== null || p.workflows !== undefined, {
        path: ["workflows"],
        message: "the root thread records the workflows it ran",
      })
      .refine((p) => p.kind !== "supervisor" || p.model === undefined, {
        path: ["model"],
        message: "the supervisor calls no model",
      })
      .refine(
        (p) =>
          p.kind === "worker" || p.kind === "check"
            ? p.task !== undefined
            : (p.kind !== "supervisor" && p.kind !== "main") || p.task === undefined,
        {
          path: ["task"],
          message: "task goes with worker and check threads, and not the supervisor or main agent",
        },
      )
      .refine((p) => p.kind !== "main" || p.model !== undefined, {
        path: ["model"],
        message: "the main agent calls a model, so it records which",
      }),
  );

  /**
   * Written by every claim on the run's root thread, right after that thread's
   * `thread.started` and before anything else the claim writes. `resumed` is false on the run's
   * first claim. On a resume, threads whose latest `thread.started` has no `thread.ended`
   * were cut off by infrastructure; the run page shows that as "Voluma restarted the run".
   * `after` is why the previous claim ended, present exactly when `resumed`.
   */
  const claimStarted = event(
    "claim.started",
    z
      .object({
        resumed: z.boolean(),
        after: claimEndReasonSchema.optional(),
        /** This claim exists because a person's message reopened the run (`messages.ts`); not a claim-end reason. */
        reopened: z.literal(true).optional(),
      })
      .refine((p) => p.resumed === (p.after !== undefined), {
        path: ["after"],
        message: "after goes with a resumed claim and no other",
      }),
  );

  /**
   * Every `thread.ended` is deliberate. A runtime abort (shutdown, self-stop, lost lease)
   * writes none, so `cancelled` always means a stop someone chose (and is final; a `completed`
   * end is resumable: a person message reopens a finished run with `run.reopened`, and the
   * harness's thread log then clears the root's ended flag): `stop_worker`, the run
   * loop's own stops, or a user's cancel of the run (which the server writes, `threads.ts`).
   */
  const threadEnded = event(
    "thread.ended",
    z.object({
      status: z.enum(["completed", "failed", "cancelled"]),
      error: z.string().optional(),
      /**
       * The root's, from `finish_run`: one or two plain sentences for the researcher. On a
       * `cancelled` end of a worker or check: why the run loop stopped it, which the main agent is told.
       */
      summary: nonEmpty.optional(),
    }),
  );

  /**
   * The runner writes one for every assistant reply, including an empty or
   * failed one. A tool call is a separate event; the `message` of a reply that
   * only calls tools has empty text.
   */
  const message = event(
    "message",
    z.discriminatedUnion("role", [
      z.object({
        role: z.literal("user"),
        text: z.string(),
        sender: userSender,
      }),
      z.object({
        role: z.literal("assistant"),
        text: z.string(),
        /**
         * The reply's reasoning (thinking), its blocks joined with a blank line; absent when
         * the model showed none. It replaces the partial the reply's `reasoning.delta` frames built.
         */
        reasoning: z.string().optional(),
        /** The reply's model usage; absent on a reply that never reached the model. */
        usage: modelUsageSchema.optional(),
      }),
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
    z
      .object({
        toolCallId: toolCallIdSchema,
        isError: z.boolean(),
        /** What the model saw: head and tail only when `truncated`. */
        output: z.string(),
        /**
         * When true the full output is at `toolOutputKey(runId, threadName, toolCallId)`: under
         * the calling thread's own folder of the run's scratch, `threadName` being its id
         * without the run id.
         */
        truncated: z.boolean(),
        /**
         * True when the call failed because of Voluma's infrastructure (gateway or provider 5xx,
         * a cut stream, a revoked token, the in-flight limit), not the agent's input; only on
         * an error result. Absent otherwise.
         */
        infrastructure: z.literal(true).optional(),
      })
      .refine((p) => p.infrastructure === undefined || p.isError, {
        path: ["infrastructure"],
        message: "an infrastructure failure is an error result",
      }),
  );

  /**
   * Sandbox lifecycle, written by the runner under the thread whose tool call
   * needed the sandbox. The sandbox is created on first use, once per run.
   */
  const sandbox = event(
    "sandbox",
    z.object({
      /**
       * The sandbox's name within the run (`<taskId>.worker[.n]`), the same string the gateway
       * token minted for it carries, so `spend` attributes its provider calls by it. The
       * thread that uses the sandbox writes the event.
       */
      name: nonEmpty,
      state: z.enum(["starting", "ready", "stopped", "failed"]),
      detail: z.string().optional(),
    }),
  );

  /**
   * A revision starts: the first at the run's start, then one per correction
   * (`taskId` is the corrected task). Written by the runtime before the writes it covers.
   */
  const revisionStarted = event(
    "revision.started",
    z.discriminatedUnion("reason", [
      /** The run's first state event; `plan` is the declared outputs of every task, copied from the workflow. */
      z.object({ reason: z.literal("run"), plan: workflowPlanSchema }),
      z.object({ reason: z.literal("correction"), taskId: taskIdSchema }),
    ]),
  );

  /** A work attempt opens on a task: its first write, or a redo after a stale mark or a failure. */
  const attemptOpened = event("attempt.opened", z.object({ taskId: taskIdSchema }));

  /**
   * A task changed status. Written when a task tool call succeeds (`by` agent)
   * or by the runtime's own code (`by` rule); the envelope `threadId` is the thread whose
   * tool or rule produced it.
   */
  const task = event(
    "task",
    z.object({
      taskId: taskIdSchema,
      /** Runtime-stamped: the attempt this belongs to. */
      attemptId: nonEmpty,
      status: taskStatusSchema,
      /** One plain-language line: why, shown beside the state. */
      reason: nonEmpty,
      by: bySchema,
    }),
  );

  /**
   * A milestone under a task, in the mockup's progress-line style, from a
   * worker or check thread's `checkpoint` tool.
   */
  const checkpoint = event(
    "checkpoint",
    z.object({
      taskId: taskIdSchema,
      attemptId: nonEmpty,
      /** Working detail, for the next agent and the check. */
      text: nonEmpty,
      /** One or two plain sentences for the researcher. Optional so logs written before it parse. */
      summary: nonEmpty.optional(),
      by: bySchema,
      evidence: z.array(evidenceRefSchema),
      /** The check thread's verdict line; only check threads may set it. */
      verdict: z.enum(["passed", "needs-review"]).optional(),
      /** Raises a To check item: `text` is its detail; the fold resolves `focus` ids (`fold.ts`). */
      toCheck: z.object({ title: nonEmpty, focus: focusSchema.optional() }).optional(),
    }),
  );

  /**
   * A result from `report_output` (`output.ts`). A new attempt reports the same
   * `outputId` again; within an attempt the latest wins.
   */
  const output = event(
    "output",
    outputReportSchema.extend({ taskId: taskIdSchema, attemptId: nonEmpty }),
  );

  /**
   * The main agent changed the plan, written by the main thread before the change applies;
   * id `<thread>:<toolCallId>:change_plan`. The fold applies it over the plan so far, without
   * reading the workflow: `add` carries full plan entries (declarations copied from the workflow's
   * `tasks.json`), `adHoc` tasks have no outputs, `doneWhen` and `instructions` are appended
   * to the task's. `skip` is fold state (`fold.ts`): the task and its transitive dependents
   * fold as `to-check` with every declared output missing and the reason; the runtime writes
   * no attempt for it.
   *
   * Rules. A task id is unique in the plan: no id repeats across `add` and `adHoc` (refused
   * here), and the fold applies an `add` or `adHoc` only when its id is not already in the plan
   * (the first wins), so a collision can never replace a task's outputs. The schema can't see
   * the plan, so the runtime refuses a collision itself and validates the resulting plan with
   * `workflowPlanSchema` (no cycles, every dependency exists) before it writes this event.
   * `doneWhen` and `instructions` for an unknown task are ignored.
   */
  const planChanged = event(
    "plan.changed",
    z
      .object({
        reason: nonEmpty,
        add: z.array(planTaskSchema).optional(),
        adHoc: z
          .array(
            z.object({
              id: taskIdSchema,
              title: nonEmpty,
              instructions: nonEmpty,
              dependsOn: z.array(taskIdSchema),
            }),
          )
          .optional(),
        doneWhen: z
          .array(z.object({ taskId: taskIdSchema, lines: z.array(nonEmpty).min(1) }))
          .optional(),
        instructions: z.array(z.object({ taskId: taskIdSchema, text: nonEmpty })).optional(),
        skip: z.array(z.object({ taskId: taskIdSchema, reason: nonEmpty })).optional(),
      })
      .superRefine((p, ctx) => {
        const seen = new Set<string>();
        for (const [key, tasks] of [
          ["add", p.add],
          ["adHoc", p.adHoc],
        ] as const)
          tasks?.forEach((t, i) => {
            if (seen.has(t.id))
              ctx.addIssue({
                code: "custom",
                path: [key, i, "id"],
                message: `duplicate task id "${t.id}"`,
              });
            seen.add(t.id);
          });
      }),
  );

  /** A check thread asked the main agent a question; id `<thread>:<toolCallId>:ask`. `fold` ignores it. */
  const ask = event("ask", z.object({ question: nonEmpty }));

  /**
   * The main agent answered a check thread's `ask`; id `<thread>:<toolCallId>:answer`. `askId` is
   * that `ask` event's id (a check may ask up to three times). `files` are kept like evidence.
   * `fold` ignores it.
   */
  const answer = event(
    "answer",
    z.object({
      checkThreadId: nonEmpty,
      askId: nonEmpty,
      text: nonEmpty,
      files: z.array(evidenceRefSchema).optional(),
    }),
  );

  /**
   * The main agent's answer to the researcher, from its `reply` tool (`replyInputSchema`);
   * id `<thread>:<toolCallId>:reply`. `fold` ignores it.
   */
  const reply = event("reply", replySchema);

  /**
   * Review assets (OME-Zarr levels, meshes) for one reported file were converted: the
   * manifest plus the `sourceSha256` of the file. Written by the runner's conversion worker
   * on the run's root thread (`<runId>.supervisor`); id `<runId>:assets:<sha256>`, so a retry
   * or a resumed worker stores one event. The files are under `reviewAssetKey(runId,
   * sourceSha256, path)`. The assets are a function of the source bytes and the converter
   * version, so a rerun of a task that reports the same bytes reuses them. The server serves
   * them at `GET /api/review/runs/:runId/assets/:sha256/*`: a read check on the run, the tail
   * checked as a `relativePathSchema`, then a 302 to a presigned GET with `Cache-Control:
   * no-store` on the 302 (the presigned URL expires; the file does not change).
   * Not in a review summary: `reviewState` ignores it.
   */
  const assetsReady = event(
    "assets.ready",
    reviewAssetsManifestSchema.extend({ sourceSha256: sha256Schema }),
  );

  /** Conversion of the file with this `sourceSha256` failed (or timed out at the end of the run); same id as `assets.ready`. Permanent for the run. The writer truncates `error` to `ASSET_ERROR_MAX`. */
  const assetsFailed = event(
    "assets.failed",
    z.object({ sourceSha256: sha256Schema, error: z.string().min(1).max(ASSET_ERROR_MAX) }),
  );

  return z.discriminatedUnion("type", [
    claimStarted,
    threadStarted,
    threadEnded,
    message,
    toolCall,
    toolResult,
    sandbox,
    revisionStarted,
    attemptOpened,
    task,
    checkpoint,
    output,
    planChanged,
    ask,
    answer,
    reply,
    assetsReady,
    assetsFailed,
  ]);
};

/** What a runner appends: an event without `seq`, never a human review decision. */
export const eventInputSchema = eventUnion({});
export type EventInput = z.infer<typeof eventInputSchema>;

const stored = { seq: z.number().int().nonnegative() };

/** A stored event: runner events reuse their definitions; only reads include human decisions. */
export const runEventSchema = z
  .discriminatedUnion("type", [
    eventUnion(stored),
    z.object({
      ...envelope,
      ...stored,
      type: z.literal("check.accepted"),
      payload: checkAcceptedSchema,
    }),
    z.object({
      ...envelope,
      ...stored,
      type: z.literal("review.completed"),
      payload: reviewCompletedSchema,
    }),
    z.object({
      ...envelope,
      ...stored,
      type: z.literal("person.message"),
      payload: personMessageSchema,
    }),
    z.object({
      ...envelope,
      ...stored,
      type: z.literal("run.reopened"),
      payload: runReopenedSchema,
    }),
    z.object({
      ...envelope,
      ...stored,
      type: z.literal("correction.ended"),
      payload: correctionEndedSchema,
    }),
  ])
  .refine(
    (e) =>
      (e.type !== "check.accepted" && e.type !== "review.completed") ||
      e.threadId === `${e.runId}.reviewer`,
    { path: ["threadId"], message: "human review decisions belong to <runId>.reviewer" },
  )
  .refine(
    (e) =>
      (e.type !== "person.message" && e.type !== "run.reopened" && e.type !== "correction.ended") ||
      e.threadId === `${e.runId}.person`,
    { path: ["threadId"], message: "correction events belong to <runId>.person" },
  );
export type RunEvent = z.infer<typeof runEventSchema>;
export type EventType = RunEvent["type"];

/** A page of a run's stored events, oldest first. */
export const runEventsResponseSchema = z.object({
  events: z.array(runEventSchema),
  more: z.boolean(),
});
export type RunEventsResponse = z.infer<typeof runEventsResponseSchema>;
