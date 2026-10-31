/**
 * The main agent's coordination tools: start and steer workers, answer a checker, accept a
 * rejected task, change the plan, finish the run. Every rule is here or in the task runtime;
 * a tool decides and writes inside the runtime's `section` and then tells the run loop that
 * the run changed (`Agents.changed`). Each appends under an id derived from its call
 * (`effects.ts`), so a repeated call writes nothing twice and a call a crash cut off is
 * answered from the log. Every tool is refused once the run has ended, and for any thread
 * that is not the main agent. In a correction (a researcher's message reopened the finished
 * run) the tools that start, steer or change work are refused until the researcher says go.
 * They never wait for a thread inside the section.
 */
import type { By } from "@voluma/contracts/events";
import { transitiveDependents } from "@voluma/contracts/fold";
import { taskIdSchema } from "@voluma/contracts/ids";
import { fileRefInputSchema } from "@voluma/contracts/output";
import { replyInputSchema } from "@voluma/contracts/task-tools";
import { type PlanTask, workflowPlanSchema } from "@voluma/contracts/workflow";
import type { WorkflowFiles } from "@voluma/contracts/workflow-files";
import { planTask } from "@voluma/workflow/plan";
import { z } from "zod";
import type { UserSender } from "../adapters/pi/start-thread";
import {
  feedbackText,
  GO_REFUSAL,
  goNotActedOn,
  UNANSWERED,
  UNDELIVERED,
  unfinished,
} from "../messages";
import type { Recorder } from "../recorder";
import { Refusal, type TaskRuntime } from "../task-runtime";
import { startedFor, type ThreadLog, type ThreadState, threadLog } from "../thread-log";
import { effectId } from "./effects";
import { finish, result } from "./task-tools";
import type { Tool, ToolContext } from "./tool";

/** What the run loop gives the main agent's tools to act on threads; it owns the thread pool. */
export interface Agents {
  /** A thread's state, as the loop sees it (`running` is known only to this process). */
  state(log: ThreadLog, threadId: string): ThreadState | undefined;
  /** Whether the task has used its fix rounds, by the loop's limit. */
  fixLimitReached(log: ThreadLog, taskId: string): boolean;
  /**
   * Picks the task's next worker id, appends its `thread.started` under `startedEventId`, then
   * starts it with the main agent's brief; returns the id. Call inside `section`.
   */
  startWorker(o: {
    taskId: string;
    brief: string;
    mainThreadId: string;
    spawnedBy: string;
    startedEventId: string;
  }): Promise<string>;
  /** Steers a message into a running thread; false if it is not running. */
  steer(threadId: string, text: string, sender: UserSender): boolean;
  /** Resolves once the thread is not running here. Never call it inside `section`. */
  settled(threadId: string): Promise<void>;
  /** Resumes a thread that is not running, with a message; its start is stored first. Call inside `section`. */
  resume(threadId: string, text: string, sender: UserSender): Promise<void>;
  /** The run changed: the loop takes its next step. */
  changed(): void;
}

export interface MainDeps {
  rootThreadId: string;
  recorder: Recorder;
  runtime: TaskRuntime;
  agents: Agents;
  /** The workflow's tasks, which `change_plan` adds from. */
  workflow: WorkflowFiles;
}

const nonEmpty = z.string().min(1);
const AGENT: By = { kind: "agent" };

export function mainTools(deps: MainDeps) {
  const { recorder, runtime, agents, rootThreadId, workflow } = deps;
  const log = () => threadLog(recorder.events());

  /** The main agent calls while the run is going; `work` tools also wait for the researcher's go in a correction. */
  function main(ctx: ToolContext, work = false) {
    if (ctx.kind !== "main") throw new Refusal("Only the main agent uses this tool.");
    const d = log();
    if (d.root.ended) throw new Refusal("The run has ended.");
    if (work && d.correcting && !d.go) throw new Refusal(GO_REFUSAL);
  }

  /** A tool that decides and writes inside the section, then wakes the loop. */
  function inSection<I>(
    run: (input: I, ctx: ToolContext) => Promise<unknown>,
    work = false,
  ): (input: I, ctx: ToolContext) => ReturnType<typeof result> {
    return (input, ctx) =>
      result(async () => {
        main(ctx, work);
        const done = await runtime.section(async () => {
          main(ctx, work);
          return run(input, ctx);
        });
        agents.changed();
        return done;
      });
  }

  const workerOf = (d: ThreadLog, threadId: string) => {
    const r = d.threads.get(threadId);
    if (r?.role !== "worker") {
      throw new Refusal(
        r?.role === "check"
          ? `${threadId} is a checker: answer its question with \`answer\`.`
          : `${threadId} is not a worker of this run.`,
      );
    }
    return r;
  };

  const start_worker: Tool<z.ZodObject<{ taskId: typeof taskIdSchema; brief: z.ZodString }>> = {
    name: "start_worker",
    description:
      "Start a worker on a task of the plan. `brief` is your message to it: what matters for this task beyond the task text, what earlier tasks settled, where their files are. Refused when a task it builds on has no usable result, when the task already has a live worker, is under review, or has used its fix rounds.",
    input: z.object({ taskId: taskIdSchema, brief: nonEmpty }),
    sequential: true,
    execute: inSection(async ({ taskId, brief }, ctx) => {
      const f = runtime.view();
      const d = log();
      const task = f.plan.tasks.find((t) => t.id === taskId);
      if (!task) throw new Refusal(`${taskId} is not a task of this run's plan.`);
      const t = runtime.taskOf(taskId);
      if (t?.skipped) throw new Refusal(`${taskId} was skipped: ${t.skipped.reason}`);
      const waiting = task.dependsOn.filter((id) => !runtime.taskOf(id)?.satisfied);
      if (waiting.length > 0) {
        throw new Refusal(
          `${taskId} builds on ${waiting.join(", ")}, which has no usable result yet (not done, or rejected by its check until you send feedback or accept it).`,
        );
      }
      const live = startedFor(d, taskId, "worker").find((r) => {
        const s = agents.state(d, r.id);
        return s !== "stopped" && s !== undefined;
      });
      if (live) {
        throw new Refusal(
          `${taskId} has a worker, ${live.id} (${agents.state(d, live.id)}): use \`message\` to steer or resume it, or \`stop_worker\` first${d.threads.get(live.id)?.end?.status === "failed" ? " (a worker that failed keeps its history; for a fresh one, `stop_worker` then `start_worker`)" : ""}.`,
        );
      }
      if (t?.status === "under-review") throw new Refusal(`${taskId} is under review.`);
      if (agents.fixLimitReached(d, taskId)) {
        throw new Refusal(
          `${taskId} has used its fix rounds; it stays as it is for the researcher.`,
        );
      }
      const threadId = await agents.startWorker({
        taskId,
        brief,
        mainThreadId: ctx.threadId,
        spawnedBy: ctx.toolCallId,
        startedEventId: effectId("start_worker", ctx.threadId, ctx.toolCallId),
      });
      return { message: `Worker ${threadId} started on ${taskId}.`, threadId };
    }, true),
  };

  const message: Tool<z.ZodObject<{ threadId: z.ZodString; text: z.ZodString }>> = {
    name: "message",
    description:
      "Send a message to a worker. A running worker gets it in its current turn; an idle one is resumed with it. On a task whose check rejected it, the message is your feedback: it opens a new attempt for the same worker, which fixes the task, reports its outputs again and submits. Refused for a checker (use `answer`), a stopped worker, or a task that used its fix rounds.",
    input: z.object({ threadId: nonEmpty, text: nonEmpty }),
    sequential: true,
    execute: (input, ctx) =>
      result(async () => {
        main(ctx, true);
        const { threadId, text } = input;
        const sender: UserSender = { kind: "thread", threadId: ctx.threadId };
        const before = log();
        const w = workerOf(before, threadId);
        if (agents.state(before, threadId) === "stopped") {
          throw new Refusal(`${threadId} was stopped; start a new worker for ${w.taskId}.`);
        }
        if (agents.fixLimitReached(before, w.taskId)) {
          throw new Refusal(`${w.taskId} has used its fix rounds; it stays as it is.`);
        }
        if (agents.state(before, threadId) === "running" && agents.steer(threadId, text, sender)) {
          return { message: `Delivered to ${threadId}, which is running.` };
        }
        // A thread that just ended is not running a moment later; its end is stored by then.
        await agents.settled(threadId);
        await recorder.flush();
        const done = await runtime.section(async () => {
          main(ctx, true);
          const d = log();
          workerOf(d, threadId);
          if (agents.state(d, threadId) === "stopped")
            throw new Refusal(`${threadId} was stopped.`);
          if (agents.state(d, threadId) === "running") {
            throw new Refusal(`${threadId} is running again; send the message once more.`);
          }
          const t = runtime.taskOf(w.taskId);
          // A task its check rejected, or one the researcher said go on that is finished (done, or left
          // to check by the fix limit), is redone as a new attempt of the same worker.
          const goTask =
            d.go?.taskId === w.taskId && (t?.status === "done" || t?.status === "to-check");
          const feedback = (!!t?.rejected || goTask) && d.holders.get(w.taskId) === threadId;
          if (feedback) {
            await runtime.openAttempt(
              w.taskId,
              threadId,
              effectId("message", ctx.threadId, ctx.toolCallId),
            );
          }
          await agents.resume(threadId, feedback ? feedbackText(w.taskId, text) : text, sender);
          return {
            message: feedback
              ? `Feedback sent: ${threadId} resumed on a new attempt of ${w.taskId}.`
              : `${threadId} resumed with your message.`,
          };
        });
        agents.changed();
        return done;
      }),
  };

  const wait: Tool<z.ZodObject<Record<string, never>>> = {
    name: "wait",
    description:
      "End your turn and wait. You are resumed with one message when something changes: a worker submits or stops, a check finishes or asks, a task goes stale. Ending your turn without calling a tool waits the same way.",
    input: z.object({}),
    sequential: true,
    execute: async (_input, ctx) =>
      finish(
        await result(async () => {
          main(ctx);
          return { message: "Your turn ends; you will be resumed with what changes." };
        }),
      ),
  };

  const stop_worker: Tool<z.ZodObject<{ threadId: z.ZodString; reason: z.ZodString }>> = {
    name: "stop_worker",
    description:
      "Stop a worker for good: it is never resumed. If it was working on its task, the task goes back to pending with your reason; its attempt is kept. Start a new worker on the task to redo it.",
    input: z.object({
      threadId: nonEmpty,
      reason: nonEmpty.describe(
        "One plain line for the researcher, with no mention of workers, checkers, agents, threads or task ids.",
      ),
    }),
    sequential: true,
    execute: inSection(async ({ threadId, reason }, ctx) => {
      const d = log();
      const w = workerOf(d, threadId);
      if (agents.state(d, threadId) === "stopped")
        throw new Refusal(`${threadId} is already stopped.`);
      const t = runtime.taskOf(w.taskId);
      const working = t?.status === "in-progress" && d.holders.get(w.taskId) === threadId;
      await runtime.stop(threadId, effectId("stop_worker", ctx.threadId, ctx.toolCallId));
      if (working && t?.attemptId) {
        await runtime.setStatus(
          ctx.threadId,
          effectId("stop_status", ctx.threadId, ctx.toolCallId),
          w.taskId,
          t.attemptId,
          "pending",
          reason,
          AGENT,
        );
      }
      return { message: `${threadId} stopped.${working ? ` ${w.taskId} is pending again.` : ""}` };
    }, true),
  };

  const answer: Tool<
    z.ZodObject<{
      askId: z.ZodString;
      text: z.ZodString;
      files: z.ZodOptional<z.ZodArray<typeof fileRefInputSchema>>;
    }>
  > = {
    name: "answer",
    description:
      'Answer a checker\'s question (its askId is in the message that told you). `files` are files you want the checker to open: {root: "outputs", path: <inside /outputs/<task id>/>} or {root: "scratch", path: <inside your $SCRATCH>}. The checker is resumed with your answer.',
    input: z.object({
      askId: nonEmpty,
      text: nonEmpty,
      files: z.array(fileRefInputSchema).optional(),
    }),
    sequential: true,
    execute: (input, ctx) =>
      result(async () => {
        main(ctx);
        const asker = (d: ThreadLog) => {
          const r = [...d.threads.values()].find(
            (x) => x.role === "check" && x.asks.some((a) => a.id === input.askId),
          );
          if (r?.role !== "check") throw new Refusal(`No checker asked ${input.askId}.`);
          if (r.asks.find((a) => a.id === input.askId)?.answer) {
            throw new Refusal(`${input.askId} is already answered.`);
          }
          const t = runtime.taskOf(r.taskId);
          if (
            agents.state(d, r.id) === "stopped" ||
            t?.status !== "under-review" ||
            t.threads.check !== r.id
          ) {
            throw new Refusal(`The check that asked ${input.askId} is over.`);
          }
          return r;
        };
        const target = asker(log());
        const caller = {
          threadId: ctx.threadId,
          toolCallId: ctx.toolCallId,
          kind: ctx.kind,
          batchSize: ctx.batchSize,
          signal: ctx.signal,
        };
        // Files first, outside the section: a missing one refuses the call before anything is written.
        const files = await Promise.all(
          (input.files ?? []).map((f) => runtime.keep(caller, target.taskId, f)),
        );
        const done = await runtime.section(async () => {
          main(ctx);
          const r = asker(log());
          await recorder.append(
            ctx.threadId,
            "answer",
            {
              checkThreadId: r.id,
              askId: input.askId,
              text: input.text,
              ...(files.length > 0 && { files }),
            },
            effectId("answer", ctx.threadId, ctx.toolCallId),
          );
          return { message: `Answer recorded; ${r.id} resumes with it.` };
        });
        agents.changed();
        return done;
      }),
  };

  const accept: Tool<z.ZodObject<{ taskId: typeof taskIdSchema; reason: z.ZodString }>> = {
    name: "accept",
    description:
      "Accept a task whose check rejected it (needs-review): it is left to-check for the researcher with the checker's items open, and tasks that build on it may start. Give the reason in plain words for the researcher, with no mention of workers, checkers, agents, threads or task ids.",
    input: z.object({ taskId: taskIdSchema, reason: nonEmpty }),
    sequential: true,
    execute: inSection(async ({ taskId, reason }, ctx) => {
      const t = runtime.taskOf(taskId);
      if (!t?.rejected || !t.attemptId)
        throw new Refusal(`${taskId} was not rejected by its check.`);
      await runtime.setStatus(
        ctx.threadId,
        effectId("accept", ctx.threadId, ctx.toolCallId),
        taskId,
        t.attemptId,
        "to-check",
        reason,
        AGENT,
      );
      return { message: `${taskId} accepted and left to check for the researcher.` };
    }),
  };

  const changePlanInput = z.object({
    reason: nonEmpty.describe(
      "One plain line for the researcher: why the plan changes, with no mention of workers, checkers, agents, threads or task ids.",
    ),
    add: z
      .array(taskIdSchema)
      .optional()
      .describe("Tasks of the workflow's task list to add to the plan."),
    adHoc: z
      .array(
        z.object({
          id: taskIdSchema,
          title: nonEmpty,
          instructions: nonEmpty,
          dependsOn: z.array(taskIdSchema),
        }),
      )
      .optional()
      .describe("New tasks of your own. They produce no deliverable output."),
    doneWhen: z
      .array(z.object({ taskId: taskIdSchema, lines: z.array(nonEmpty).min(1) }))
      .optional()
      .describe("Done-when lines to append to a task."),
    instructions: z
      .array(z.object({ taskId: taskIdSchema, text: nonEmpty }))
      .optional()
      .describe("Text to append to a task's instructions."),
    skip: z
      .array(z.object({ taskId: taskIdSchema, reason: nonEmpty }))
      .optional()
      .describe(
        "Tasks to skip, with the reason (one plain line for the researcher, with no mention of workers, checkers, agents, threads or task ids). Tasks that build on a skipped task are skipped too, and their outputs are reported missing.",
      ),
  });

  const change_plan: Tool<typeof changePlanInput> = {
    name: "change_plan",
    description:
      "Change the plan: add done-when lines or instructions to a task, add a task from the workflow or one of your own, skip tasks. The deliverable outputs are fixed. Refused when the result is not a valid plan, or a skipped task is under review.",
    input: changePlanInput,
    sequential: true,
    execute: inSection(async (input, ctx) => {
      const before = runtime.view();
      const plan = before.plan.tasks;
      const ids = new Set(plan.map((t) => t.id));
      const fresh = new Set<string>();
      const claim = (id: string) => {
        if (ids.has(id) || fresh.has(id)) throw new Refusal(`${id} is already a task of the plan.`);
        fresh.add(id);
      };
      const added: PlanTask[] = (input.add ?? []).map((id) => {
        const def = workflow.tasks.find((t) => t.id === id);
        if (!def) throw new Refusal(`${id} is not a task of the workflow.`);
        claim(id);
        return planTask(workflow, def, () => true);
      });
      const adHoc: PlanTask[] = (input.adHoc ?? []).map((t) => {
        claim(t.id);
        return { ...t, outputs: [] };
      });
      const all = [...plan, ...added, ...adHoc];
      const known = new Set(all.map((t) => t.id));
      for (const id of [
        ...(input.doneWhen ?? []).map((x) => x.taskId),
        ...(input.instructions ?? []).map((x) => x.taskId),
        ...(input.skip ?? []).map((x) => x.taskId),
      ]) {
        if (!known.has(id)) throw new Refusal(`${id} is not a task of the plan.`);
      }
      for (const { taskId } of input.skip ?? []) {
        if (runtime.taskOf(taskId)?.status === "under-review") {
          throw new Refusal(`${taskId} is under review: wait for its check before skipping it.`);
        }
      }
      const next = all.map((t) => {
        const lines = (input.doneWhen ?? [])
          .filter((x) => x.taskId === t.id)
          .flatMap((x) => x.lines);
        const text = (input.instructions ?? []).filter((x) => x.taskId === t.id).map((x) => x.text);
        const doneWhen = [...(t.doneWhen ?? []), ...lines];
        const instructions = [t.instructions, ...text].filter(Boolean).join("\n\n");
        return {
          ...t,
          ...(doneWhen.length > 0 && { doneWhen }),
          ...(instructions && { instructions }),
        };
      });
      const parsed = workflowPlanSchema.safeParse({ tasks: next });
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw new Refusal(`The plan would be invalid: ${issue?.path.join(".")} ${issue?.message}`);
      }
      const eventId = effectId("change_plan", ctx.threadId, ctx.toolCallId);
      await recorder.append(
        ctx.threadId,
        "plan.changed",
        {
          reason: input.reason,
          ...(added.length > 0 && { add: added }),
          ...(adHoc.length > 0 && { adHoc: input.adHoc }),
          ...(input.doneWhen && { doneWhen: input.doneWhen }),
          ...(input.instructions && { instructions: input.instructions }),
          ...(input.skip && { skip: input.skip }),
        },
        eventId,
      );
      // The fold cascades a skip to the dependents; their live threads stop with the task's.
      const skipped = new Set(
        (input.skip ?? []).flatMap(({ taskId }) => [taskId, ...transitiveDependents(next, taskId)]),
      );
      const d = log();
      for (const taskId of skipped) {
        for (const role of ["worker", "check"] as const) {
          for (const r of startedFor(d, taskId, role)) {
            const s = agents.state(d, r.id);
            if (s === "running" || s === "cut-off")
              await runtime.stop(r.id, `${eventId}:skip:${r.id}`);
          }
        }
      }
      return {
        message: `The plan changed.${skipped.size > 0 ? ` Skipped: ${[...skipped].join(", ")}.` : ""}`,
      };
    }, true),
  };

  const reply: Tool<typeof replyInputSchema> = {
    name: "reply",
    description:
      "Answer the researcher who wrote to the run, in plain words. It starts no work: after a go you act with your other tools. You may call it more than once.",
    input: replyInputSchema,
    sequential: true,
    execute: inSection(async ({ text }, ctx) => {
      await recorder.append(
        ctx.threadId,
        "reply",
        { text },
        effectId("reply", ctx.threadId, ctx.toolCallId),
      );
      return { message: "Sent to the researcher." };
    }),
  };

  const finish_run: Tool<z.ZodObject<{ summary: z.ZodString }>> = {
    name: "finish_run",
    description:
      "End the run. Refused while the researcher's last message is unanswered or their go is not acted on, while a worker or checker is running, while a task is neither done, left to check nor skipped (pending, in progress, under review, stale), while a task's check rejected it and you have not sent feedback or accepted it, and while a selected output is neither reported nor skipped with a reason. `summary` is one or two plain sentences for the researcher, with no mention of workers, checkers, agents, threads or task ids.",
    input: z.object({ summary: nonEmpty }),
    sequential: true,
    execute: async (input, ctx) =>
      finish(
        await inSection(async ({ summary }: { summary: string }, c: ToolContext) => {
          const view = runtime.view();
          const d = log();
          const running = [...d.threads.values()].filter(
            (r) => r.role !== "main" && agents.state(d, r.id) === "running",
          );
          const problems = [
            ...(d.undelivered.some((n) => n.kind === "person") ? [UNDELIVERED] : []),
            ...(d.unanswered ? [UNANSWERED] : []),
            ...(d.go && !d.go.redone ? [goNotActedOn(d.go.taskId)] : []),
            ...running.map((r) => `${r.id} (${r.role}, ${r.taskId}) is still running.`),
            ...unfinished(view).map((t) =>
              t.status === "pending"
                ? `${t.id} has not run: start a worker on it, or skip it with a reason.`
                : `${t.id} is ${t.status}: get it done, or skip it with a reason.`,
            ),
            ...view.tasks.flatMap((t) => {
              if (t.skipped) return [];
              if (t.rejected)
                return [
                  `${t.id} was rejected by its check: send feedback with \`message\` or \`accept\` it.`,
                ];
              return t.missingRequired.length > 0
                ? [
                    `${t.id}: required outputs not reported: ${t.missingRequired.join(", ")} (get them reported, or skip the task with a reason).`,
                  ]
                : [];
            }),
          ];
          if (problems.length > 0)
            throw new Refusal(`The run cannot finish yet:\n${problems.join("\n")}`);
          await recorder.append(
            rootThreadId,
            "thread.ended",
            { status: "completed", summary },
            effectId("finish_run", c.threadId, c.toolCallId),
          );
          return { message: "The run is finished." };
        })(input, ctx),
      ),
  };

  return {
    start_worker,
    message,
    wait,
    stop_worker,
    answer,
    accept,
    change_plan,
    reply,
    finish_run,
  };
}
