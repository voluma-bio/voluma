/**
 * The run event log: agent activity and human review decisions, in order. The envelope is the
 * same for every kind; `type` selects the payload. The runner appends events
 * (`eventInputSchema`; `id` is chosen by the client so a retried POST is a
 * no-op, and the POST carries the run's lease token, `LEASE_TOKEN_HEADER` in
 * `runner.ts`, whose 409 means the runner stops); the server stamps `seq`,
 * unique and increasing per run, which is also the stream cursor the UI
 * resumes from. The POST answers 200 `appendEventResponseSchema` with the event's stored
 * `seq` (for an id already stored, the seq it has); a 204 with no body, from an API before
 * that, is still accepted by the runner, which then fills no gap (`recorder.ts`).
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
 * Ids that become R2 key segments (`runId`, `toolCallId`, version paths) are checked
 * with the `r2.ts` schemas here, so an accepted event can't fail later when a
 * key is built.
 *
 * `person.message`, `run.reopened` and `correction.ended` are server-authored correction events
 * on the fixed thread `<runId>.person` (not a thread: it never starts), readable in runEventSchema
 * and rejected by the runner's eventInputSchema (payloads, ids and rules in messages.ts).
 * `corrections.ts` reads the spans they make.
 */
import { z } from "zod";
import {
  activitySchema,
  agentMessageSchema,
  approvalAnsweredSchema,
  approvalRequestedSchema,
  approvalSettledSchema,
  bashBackgroundedSchema,
  bashEndedSchema,
  closeRequestedSchema,
  markDeletedSchema,
  markPlacedSchema,
  outputPublishedSchema,
  outputsChangedSchema,
  pingSchema,
  skillLoadedSchema,
  tocheckResolvedSchema,
  viewSavedSchema,
} from "./agent-events";
import { modelRefSchema, runIdSchema, toolCallIdSchema } from "./ids";
import { correctionEndedSchema, personMessageSchema, runReopenedSchema } from "./messages";
import { sha256Schema } from "./r2";
import { reviewAssetsManifestSchema } from "./review";
import { claimEndReasonSchema } from "./runner";
import { recordedPinSchema } from "./workflow";

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
    z.object({
      kind: z.literal("thread"),
      threadId: nonEmpty,
      /** The `agent.message` event a delivery carries, so the agent loop knows what was delivered. */
      messageId: nonEmpty.optional(),
    }),
    z.object({
      kind: z.literal("runtime"),
      /**
       * On a delivery to the main agent: the id of the last log event the delivery
       * accounted for, so what follows it is undelivered.
       */
      covers: nonEmpty.optional(),
      /** A context-compaction notice, not a nudge. */
      notice: z.literal(true).optional(),
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
        /**
         * The thread's name: `supervisor`, `main`, `main.2`, `segmentation.worker`. It is its sandbox's name (a worker's folder under
         * `/work` is the name; main's is `main`), and the same on every start of the thread.
         */
        name: nonEmpty,
        /** Null on a run's root thread. */
        parentThreadId: z.string().nullable(),
        /**
         * OVERLAP: the role again, or `supervisor` on the root. Nothing reads it; it stays
         * optional (and is still written) so a thread started by a build before this one parses
         * in both directions (TODO: drop, `packages/contracts/.context/TODO.md`).
         */
        kind: nonEmpty.optional(),
        /** The tool call in the parent thread that started this thread. */
        spawnedBy: nonEmpty.optional(),
        /** The workflow files the run ran, with the commit the runner's checkout was at; required on the root thread; child threads may omit it. */
        workflows: z.array(recordedPinSchema).min(1).optional(),
        /**
         * The sandbox image (`registry/name@sha256:…`) the run's sandboxes use; every claim
         * writes it on the root thread and the first one decides it, so a resume keeps the image
         * the run began on. Absent on a run recorded before the field existed: the next claim
         * records its runner's image.
         */
        sandboxImage: nonEmpty.optional(),
        /**
         * The model this thread calls, as the runner names it: `provider/id`
         * (`meta/muse-spark-1.3`). Main and worker threads call one and
         * should set it. The root thread sets none: it runs no model (the `main` thread,
         * its child, is the run's main agent). A thread's model is
         * fixed for its life: every `thread.started` of a thread names the same one, and
         * the harness fails a resume on a different model, as it does for a differing
         * system prompt.
         */
        model: modelRefSchema.optional(),
        /**
         * The user message a resume starts with (an answer, feedback, a delivery, a nudge),
         * stored with the start because the thread's own `message` event comes only after it
         * loads its history. A start with no user message after it was cut off before it got
         * its input, and the next claim resumes it with this. Absent on a thread's first start.
         */
        input: z.object({ text: z.string(), sender: userSender }).optional(),
        /** `main`, or a `worker` main started; absent on the root. */
        role: z.enum(["main", "worker"]).optional(),
        /** The closed worker (its `name`) this worker starts from, with its note, folder and transcript. */
        from: nonEmpty.optional(),
        /** The worker (its `name`) this one must not see: the two exchange messages with main only. */
        blind: nonEmpty.optional(),
        /**
         * OVERLAP: written `"agents"` on the root thread because a runner built before the task
         * loop was deleted pins `harness ?? "tasks"` when it resumes a run (TODO: drop with the
         * claim's `harness`, `packages/contracts/.context/TODO.md`).
         */
        harness: z.literal("agents").optional(),
      })
      .refine((p) => p.parentThreadId !== null || p.workflows !== undefined, {
        path: ["workflows"],
        message: "the root thread records the workflows it ran",
      })
      .refine((p) => p.parentThreadId !== null || p.model === undefined, {
        path: ["model"],
        message: "the root thread calls no model",
      })
      .refine((p) => p.parentThreadId === null || p.role !== undefined, {
        path: ["role"],
        message: "a thread under the root says its role",
      })
      .refine((p) => p.role !== "main" || p.model !== undefined, {
        path: ["model"],
        message: "the main agent calls a model, so it records which",
      }),
  );

  /**
   * Written by every claim on the run's root thread, right after that thread's
   * `thread.started` and before anything else the claim writes. `resumed` is false on the run's
   * first claim. On a resume, threads whose latest `thread.started` has no `thread.ended`
   * were cut off by infrastructure; the run page shows that as "Voluma restarted the run".
   * `after` is why the previous claim ended; `reopened` says a person's message reopened the run
   * instead (the reopen clears the claim-end reason). A resumed claim has exactly one of them.
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
      .refine((p) => p.resumed === (p.after !== undefined || p.reopened === true), {
        path: ["after"],
        message: "a resumed claim says why: after a claim end, or after a reopen",
      })
      .refine((p) => !(p.after !== undefined && p.reopened === true), {
        path: ["reopened"],
        message: "a claim follows a claim end or a reopen, not both",
      }),
  );

  /**
   * Every `thread.ended` is deliberate. A runtime abort (shutdown, self-stop, lost lease)
   * writes none, so `cancelled` always means a stop someone chose: `stop_worker`, the run
   * loop's own stops, or a user's cancel of the run (which the server writes, `threads.ts`). A
   * stopped thread is not resumed (a correction's message to a stopped main agent starts a new
   * `main.<n>`); a `completed` end is resumable: a person message reopens a finished run with
   * `run.reopened`, and the agent log then clears the root's ended flag.
   */
  const threadEnded = event(
    "thread.ended",
    z.object({
      status: z.enum(["completed", "failed", "cancelled", "closed"]),
      error: z.string().optional(),
      /**
       * A `failed` end whose model reply had started when the provider's error came (a dropped
       * stream, an error sent inside the stream): the provider's retries end at the response
       * headers, so nothing retried it. Absent otherwise, and on ends written before the field.
       */
      interrupted: z.literal(true).optional(),
      /**
       * The root's, from `close`: one or two plain sentences for the researcher. On a
       * `cancelled` end of a worker: why the loop stopped it.
       */
      summary: nonEmpty.optional(),
      /** On a `closed` end: what a new worker needs to carry on from this one (`from`). */
      note: nonEmpty.optional(),
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
        /**
         * The text is the summary that replaced the thread's earlier history, not something the
         * thread said: views leave it out of what the thread said or replied. Its usage is spend.
         */
        compaction: z.literal(true).optional(),
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
   * stored (`stream.ts`); this and the spilled file are the record.
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
         * When true the full output is at `/work/<folder>/.tool-output/<toolCallId>` in the
         * calling thread's own folder (`ThreadLayout.toolOutputPath`).
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
       * The sandbox's name within the run (`main`, `segmentation.worker`), the same string the gateway
       * token minted for it carries, so `spend` attributes its provider calls by it. The
       * thread that uses the sandbox writes the event.
       */
      name: nonEmpty,
      state: z.enum(["starting", "ready", "stopped", "failed"]),
      detail: z.string().optional(),
    }),
  );

  const outputPublished = event("output.published", outputPublishedSchema);
  const outputsChanged = event("outputs.changed", outputsChangedSchema);
  const agentMessage = event("agent.message", agentMessageSchema);
  const closeRequested = event("close.requested", closeRequestedSchema);
  const ping = event("ping", pingSchema);
  const activity = event("activity", activitySchema);
  const approvalRequested = event("approval.requested", approvalRequestedSchema);
  const approvalSettled = event("approval.settled", approvalSettledSchema);
  const bashBackgrounded = event("bash.backgrounded", bashBackgroundedSchema);
  const bashEnded = event("bash.ended", bashEndedSchema);
  const skillLoaded = event("skill.loaded", skillLoadedSchema);

  /**
   * Review assets (OME-Zarr levels, meshes) for one reported file were converted: the
   * manifest plus the `sourceSha256` of the file. Written by the runner's conversion worker
   * on the run's root thread (`thread.started` with no parent); id `<runId>:assets:<sha256>`, so a retry
   * or a resumed worker stores one event. The files are under `reviewAssetKey(runId,
   * sourceSha256, path)`. The assets are a function of the source bytes and the converter
   * version, so a rerun that reports the same bytes reuses them. The server serves
   * them at `GET /api/review/runs/:runId/assets/:sha256/*`: a read check on the run, the tail
   * checked as a `relativePathSchema`, then a 302 to a presigned GET with `Cache-Control:
   * no-store` on the 302 (the presigned URL expires; the file does not change).
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
    assetsReady,
    assetsFailed,
    outputsChanged,
    outputPublished,
    agentMessage,
    closeRequested,
    ping,
    activity,
    approvalRequested,
    approvalSettled,
    bashBackgrounded,
    bashEnded,
    skillLoaded,
  ]);
};

/** What a runner appends: an event without `seq`, never a human review decision. */
export const eventInputSchema = eventUnion({});
export type EventInput = z.infer<typeof eventInputSchema>;

const stored = { seq: z.number().int().nonnegative() };

/** A stored event: runner events reuse their definitions; only reads include human decisions. */
export const runEventSchema = z.discriminatedUnion("type", [
  eventUnion(stored),
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
  z.object({
    ...envelope,
    ...stored,
    type: z.literal("tocheck.resolved"),
    payload: tocheckResolvedSchema,
  }),
  z.object({
    ...envelope,
    ...stored,
    type: z.literal("approval.given"),
    payload: approvalAnsweredSchema,
  }),
  z.object({
    ...envelope,
    ...stored,
    type: z.literal("approval.declined"),
    payload: approvalAnsweredSchema,
  }),
  z.object({ ...envelope, ...stored, type: z.literal("view.saved"), payload: viewSavedSchema }),
  z.object({ ...envelope, ...stored, type: z.literal("mark.placed"), payload: markPlacedSchema }),
  z.object({ ...envelope, ...stored, type: z.literal("mark.deleted"), payload: markDeletedSchema }),
]);
export type RunEvent = z.infer<typeof runEventSchema>;
export type EventType = RunEvent["type"];

export const appendEventResponseSchema = z.object({ seq: z.number().int().positive() });

/** A page of a run's stored events, oldest first. */
export const runEventsResponseSchema = z.object({
  events: z.array(runEventSchema),
  more: z.boolean(),
});
export type RunEventsResponse = z.infer<typeof runEventsResponseSchema>;
