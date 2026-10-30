/**
 * The runtime behind the task tools: every write of a `task`, `checkpoint`, `output`, `ask`,
 * `attempt.opened` or `revision.started` event by a thread's tool call, under the rules in
 * `@voluma/contracts/task-tools`. The run loop and the main agent's tools write their own
 * events through `setStatus`, `openAttempt` and `stop`, inside the same `section`. Its only view of the run is
 * `threadLog` of the recorder's events (the fold and the thread facts), derived once per change of the log; it keeps no second
 * record. Each decision and its appends run inside one per-run critical section (`section`),
 * whichever thread asks, and the recorder adds an event to the view only once it is stored.
 * Slow work (hashing and copying evidence) happens outside the section, and the decision is
 * checked again inside. A thread's kind and task come from the call (`Caller`), not from the
 * log, which may not yet hold its `thread.started`. A refusal is thrown as a `Refusal`: the
 * tool turns it into the error the model reads, and nothing is appended. A store failure is
 * an ordinary error: the tool call fails, and the run loop fails the run when its own
 * append hits one.
 */

import type { By, ThreadKind } from "@voluma/contracts/events";
import type { Folded, FoldedTask } from "@voluma/contracts/fold";
import type { EvidenceRef } from "@voluma/contracts/output";
import type {
  AskInput,
  CheckpointInput,
  ReportOutputInput,
  SubmitTaskInput,
  TaskToolResult,
} from "@voluma/contracts/task-tools";
import type { WorkflowPlan } from "@voluma/contracts/workflow";
import { isSatisfied, transitiveDependents } from "@voluma/workflow";
import type { ThreadLayout } from "./layout";
import { declarationProblem, placementProblem, referenceProblem } from "./output-checks";
import { type Evidence, EvidenceNotFound, EvidenceRefused } from "./ports/evidence";
import type { Sandbox } from "./ports/sandbox";
import type { PayloadOf, Recorder } from "./recorder";
import { isThreadName, parseThreadId } from "./thread-id";
import { startedFor, threadLog } from "./thread-log";
import { effectId } from "./tools/effects";

/** A check thread may ask the main agent this many questions. */
export const MAX_ASKS = 3;

/** A plan task as the workflow declares it (`workflowPlanSchema`). */
export type PlanTask = WorkflowPlan["tasks"][number];

/** The calling tool call, and the thread's identity (`ToolContext`). */
export interface Caller {
  threadId: string;
  toolCallId: string;
  kind: ThreadKind;
  taskId?: string;
  /** How many tool calls the reply that made this call holds (`ToolContext.batchSize`). */
  batchSize: number;
  /** Aborts when the call is cancelled. */
  signal: AbortSignal;
}

/** The call broke a rule; the message is what the model reads. */
export class Refusal extends Error {}

export interface TaskRuntimeOptions {
  recorder: Recorder;
  evidence: Evidence;
  runId: string;
  /**
   * The calling thread's view of the files: evidence it names must be readable through it. The
   * layout asks `cited` for a checker's reads of the worker's scratch.
   */
  layoutOf(threadId: string, cited: (path: string) => boolean): ThreadLayout;
  /** A thread's own sandbox (`sandboxSession.get`): evidence is hashed in it. */
  sandbox(threadId: string, options?: { note?: boolean }): Promise<Sandbox>;
  /** The thread under which the run's first event is written. */
  rootThreadId: string;
  /** The plan the run starts with (written by `start`); later plans are `view().plan` (`plan.changed`). */
  plan: readonly PlanTask[];
  /**
   * Aborts the thread if it runs here; never waits for it. The runtime has stored its end
   * first (`stop`), so its next write is refused whatever it was doing.
   */
  abortThread(threadId: string): void;
}

const AGENT: By = { kind: "agent" };

/** Who a call writes as, and the attempt it writes to. */
interface Target {
  attempt(): Promise<string>;
  /** The call opens a new attempt, so the fold's view of the current one does not apply. */
  fresh: boolean;
}

type OutputInput = ReportOutputInput["output"];
type FileInput = Extract<OutputInput, { kind: "file" }>["file"];

/** The sandbox path of a file the task names: the inverse of `refOf`. */
export const pathOf = (taskId: string, f: Pick<EvidenceRef, "root" | "path">): string =>
  f.root === "scratch" ? `/scratch/${f.path}` : `/outputs/${taskId}/${f.path}`;

/** The `{root, path}` of a sandbox path as a script prints it; only this task's outputs and the scratch have one. */
export function refOf(taskId: string, path: string): Pick<EvidenceRef, "root" | "path"> {
  const own = `/outputs/${taskId}/`;
  if (path.startsWith(own)) return { root: "outputs", path: path.slice(own.length) };
  if (path.startsWith("/scratch/")) {
    const rest = path.slice("/scratch/".length);
    // A tool-call scratch path is relative to the caller's folder unless it starts with a thread name, so a file
    // printed at the scratch root cannot be named; a script writes in $SCRATCH, which is a thread folder.
    if (!isThreadName(rest.split("/")[0] ?? "")) {
      throw new Refusal(
        `${path} is not in a thread's folder under /scratch/. Write files under $SCRATCH and report them by that path.`,
      );
    }
    return { root: "scratch", path: rest };
  }
  throw new Refusal(
    `${path} is not a file this task can report: it is not under ${own} or /scratch/ (a file in another task's outputs is not yours to report).`,
  );
}

/** The stored output: the file it names as its own is kept, and carries its sha256. */
async function storedOutput(
  output: OutputInput,
  keepFile: (file: FileInput) => Promise<EvidenceRef>,
): Promise<PayloadOf<"output">["output"]> {
  switch (output.kind) {
    case "structure": {
      const s = output.structure;
      return "mask" in s
        ? { ...output, structure: { ...s, mask: await keepFile(s.mask) } }
        : (output as PayloadOf<"output">["output"]);
    }
    case "surface":
      return {
        ...output,
        surface: { ...output.surface, heights: await keepFile(output.surface.heights) },
      };
    case "volume":
      return { ...output, volume: { ...output.volume, file: await keepFile(output.volume.file) } };
    case "file":
      return { ...output, file: await keepFile(output.file) };
    default:
      return output;
  }
}

export function taskRuntime(options: TaskRuntimeOptions) {
  const { recorder, evidence, runId, layoutOf, sandbox, rootThreadId, abortThread } = options;

  let tail: Promise<unknown> = Promise.resolve();
  /** The per-run critical section: decisions run one at a time, each seeing every earlier write. */
  const section = <T>(fn: () => Promise<T>): Promise<T> => {
    const result = tail.then(fn);
    tail = result.catch(() => {});
    return result;
  };

  const log = () => threadLog(recorder.events());
  const view = (): Folded => log().view;
  const taskOf = (id: string): FoldedTask | undefined => view().tasks.find((t) => t.id === id);
  /** The plan now, with every `plan.changed` applied. */
  const planNow = () => view().plan.tasks;

  /**
   * Whether the attempt of `taskId` cites this scratch file (the path after `/scratch/`): a
   * checkpoint or output of it, or a file the main agent attached to an answer for its check.
   */
  const cites = (taskId: string, path: string) =>
    !!taskOf(taskId)?.citedScratch.includes(path) || !!log().answeredScratch.get(taskId)?.has(path);

  const known = (taskId: string) => {
    const t = planNow().find((p) => p.id === taskId);
    if (!t) throw new Refusal(`${taskId} is not a task of this run's plan`);
    return t;
  };

  /** One `task` event: `id` makes it a no-op when written twice. */
  const setStatus = (
    threadId: string,
    id: string,
    taskId: string,
    attemptId: string,
    status: FoldedTask["status"],
    reason: string,
    by: By,
  ) => recorder.append(threadId, "task", { taskId, attemptId, status, reason, by }, id);

  /** Whether a dependent has a result a correction of what it builds on would invalidate. */
  const attempted = (dep: string) => {
    const t = taskOf(dep);
    return !!t?.attemptId && t.status !== "stale";
  };

  /**
   * The one way an attempt opens: `attempt.opened` under `holderThreadId`, id `eventId`. A task
   * that already had a result stops the live threads of every dependent (they may have read
   * its old files); if a dependent has an attempt, a correction revision first marks it stale.
   * Call inside `section`.
   */
  async function openAttempt(taskId: string, holderThreadId: string, eventId: string) {
    if (taskOf(taskId)?.attemptId) {
      const dependents = transitiveDependents(planNow(), taskId);
      if (dependents.some(attempted)) {
        await recorder.append(
          holderThreadId,
          "revision.started",
          { reason: "correction", taskId },
          `${eventId}:revision`,
        );
      }
      await staleDependents(holderThreadId, eventId, taskId, dependents);
    }
    await recorder.append(holderThreadId, "attempt.opened", { taskId }, eventId);
    return eventId;
  }

  /**
   * The declared outputs the task's previous attempt reported (the latest earlier attempt handed
   * to a check, whatever it reported, `missing` included) that its current attempt has not: only
   * the current attempt's reports count, so each would otherwise vanish. An attempt that was never
   * submitted (a stopped half-redo) is not the baseline. `fresh`: the current attempt
   * is not opened yet, so every attempt in the log is earlier. Read from the events, which the
   * fold keeps only for the current attempt.
   */
  function droppedOutputs(taskId: string, fresh: boolean): string[] {
    const reported = new Map<string, Set<string>>();
    const opened: string[] = [];
    const checked = new Set<string>();
    for (const e of recorder.events()) {
      if (e.type === "attempt.opened" && e.payload.taskId === taskId) opened.push(e.id);
      if (e.type === "task" && e.payload.taskId === taskId && e.payload.status === "under-review")
        checked.add(e.payload.attemptId);
      if (e.type === "output" && e.payload.taskId === taskId) {
        const ids = reported.get(e.payload.attemptId) ?? new Set<string>();
        reported.set(e.payload.attemptId, ids.add(e.payload.outputId));
      }
    }
    const earlier = fresh ? opened : opened.slice(0, -1);
    const previous = earlier.filter((a) => checked.has(a)).at(-1);
    const now = fresh ? undefined : opened.at(-1);
    const declared = known(taskId).outputs;
    return declared
      .map((o) => o.id)
      .filter(
        (id) => previous && reported.get(previous)?.has(id) && !reported.get(now ?? "")?.has(id),
      );
  }

  /**
   * Stores the thread's end as cancelled, then aborts it without waiting: it is stopped from
   * this moment, and its own later end is dropped. A thread already stopped is left alone.
   * Call inside `section`; `eventId` derives from what stops it. A `reason` is a stop the main
   * agent did not ask for and must be told of.
   */
  async function stop(threadId: string, eventId: string, reason?: string) {
    const record = log().threads.get(threadId);
    if (record && record.end?.status !== "cancelled") {
      await recorder.append(
        threadId,
        "thread.ended",
        { status: "cancelled", ...(reason && { summary: reason }) },
        eventId,
      );
    }
    abortThread(threadId);
  }

  /**
   * Who a call writes as and where. A check thread writes to the attempt under review; only it
   * sets a verdict. A worker writes only to its own task, the main agent to any it may hold.
   * The current attempt takes the write when the caller opened it, it has no verdict yet and
   * the task is not stale or failed. Otherwise the caller's write opens a new attempt, if the
   * caller is eligible (the task's latest non-stopped worker; the main agent when no worker of
   * the task is live) and every task this one builds on is satisfied. Nothing is opened until
   * the call is sure to write (`attempt()`), so a refusal later leaves no `attempt.opened` behind.
   */
  function writeTarget(
    c: Caller,
    taskId: string,
    { verdict, what }: { verdict: boolean; what: string },
  ): Target {
    known(taskId);
    const d = log();
    if (d.threads.get(c.threadId)?.end?.status === "cancelled") {
      throw new Refusal("You were stopped; stop here.");
    }
    if (c.kind === "check") {
      if (c.taskId !== taskId) {
        throw new Refusal(
          `You are checking ${c.taskId}; you can write only to it, not to ${taskId}.`,
        );
      }
      const t = taskOf(taskId);
      // The check thread's own `thread.started` may not be stored yet, so an unset one is this thread's.
      if (t?.status !== "under-review" || (t.threads.check && t.threads.check !== c.threadId)) {
        throw new Refusal(`${taskId} is no longer under review; stop here.`);
      }
      const attemptId = t.attemptId;
      if (!attemptId) throw new Refusal(`${taskId} has no attempt to check.`);
      return { attempt: async () => attemptId, fresh: false };
    }
    if (c.kind !== "worker" && c.kind !== "main") {
      throw new Refusal(`Only a worker, the main agent or a check thread ${what}.`);
    }
    if (verdict) throw new Refusal("Only a check thread sets a verdict.");
    if (c.kind === "worker" && c.taskId !== taskId) {
      throw new Refusal(`You work on ${c.taskId}; you can write only to it, not to ${taskId}.`);
    }
    const t = taskOf(taskId);
    const status = t?.status ?? "pending";
    if (t?.skipped) throw new Refusal(`${taskId} was skipped: ${t.skipped.reason}`);
    if (status === "under-review") {
      throw new Refusal(`${taskId} is under review: only the check thread writes to it.`);
    }
    const attemptId = t?.attemptId;
    if (
      attemptId &&
      d.holders.get(taskId) === c.threadId &&
      !t.checker &&
      status !== "stale" &&
      status !== "failed"
    ) {
      return { attempt: async () => attemptId, fresh: false };
    }
    const workers = startedFor(d, taskId, "worker").filter((r) => r.end?.status !== "cancelled");
    if (c.kind === "main") {
      if (workers.length > 0) {
        throw new Refusal(
          `${taskId} has a worker (${workers[0]?.id}); it is not yours to write to.`,
        );
      }
    } else {
      // Its own `thread.started` may not be stored yet: a thread not in the log is the newest.
      const latest = workers.at(-1);
      if (latest && latest.id !== c.threadId && d.threads.has(c.threadId)) {
        throw new Refusal(`${taskId} is held by a newer worker (${latest.id}); stop here.`);
      }
    }
    const waiting = known(taskId).dependsOn.filter((d) => !isSatisfied(taskOf(d)));
    if (waiting.length > 0) {
      throw new Refusal(
        `${taskId} builds on ${waiting.join(", ")}, which has no usable result yet.`,
      );
    }
    return {
      attempt: () => openAttempt(taskId, c.threadId, effectId("open", c.threadId, c.toolCallId)),
      fresh: true,
    };
  }

  /**
   * A write that needs slow work first (hashing and copying evidence). The target is checked
   * before it, so a refused call copies nothing, and again inside the section.
   */
  async function write<P>(
    target: () => Target,
    prepare: () => Promise<P>,
    append: (target: Target, prepared: P) => Promise<TaskToolResult>,
  ): Promise<TaskToolResult> {
    target();
    const prepared = await prepare();
    return section(() => append(target(), prepared));
  }

  /**
   * The correction of `taskId` reaches each of its dependents: its live threads are stopped
   * first, append-first, whatever the task's status and whether or not it has an attempt (a
   * worker may have read the old files; idle ones too, which would otherwise block
   * `start_worker` on the stale task; a check has no result to write). A dependent with an
   * attempt that isn't stale yet is then marked stale, and that mark tells the main agent; the
   * stop of a dependent without one says why itself.
   */
  async function staleDependents(
    threadId: string,
    prefix: string,
    taskId: string,
    dependents: readonly string[],
  ) {
    for (const dep of dependents) {
      const t = taskOf(dep);
      const mark = attempted(dep);
      const d = log();
      const holders = [...startedFor(d, dep, "worker"), ...startedFor(d, dep, "check")];
      for (const h of holders) {
        if (h.end?.status !== "cancelled") {
          await stop(
            h.id,
            `${prefix}:stale:${dep}:end:${h.id}`,
            mark ? undefined : `${taskId} was corrected, so it may have read files that changed.`,
          );
        }
      }
      if (mark && t?.attemptId) {
        await setStatus(
          threadId,
          `${prefix}:stale:${dep}`,
          dep,
          t.attemptId,
          "stale",
          `${taskId} was corrected, so this result may no longer hold.`,
          { kind: "rule", rule: "stale" },
        );
      }
    }
  }

  /**
  /**
   * The sha256 of a file, computed by the thread's sandbox: a scan-sized file stays off the
   * host. The file goes in on stdin so the output never carries its name (GNU `sha256sum`
   * escapes `\` and newline in names). `note: false`: this exec is the host's, so the restart
   * note stays owed to the model's next command.
   */
  const sandboxHash = async (
    threadId: string,
    path: string,
    signal: AbortSignal,
  ): Promise<string> => {
    let out = "";
    let err = "";
    let code = -1;
    const command = `sha256sum < '${path.replaceAll("'", "'\\''")}'`;
    const box = await sandbox(threadId, { note: false });
    for await (const chunk of box.exec({ command, timeoutSeconds: 900 }, signal)) {
      if (chunk.type === "exit") code = chunk.code;
      else if (chunk.type === "stdout") out += chunk.data;
      else if (chunk.type === "stderr") err += chunk.data;
    }
    const sha256 = /^[0-9a-f]{64}(?= )/.exec(out)?.[0];
    if (code !== 0 || !sha256) {
      throw new Error(`could not hash ${path} (exit ${code}): ${err.trim() || out.trim()}`);
    }
    return sha256;
  };

  /**
   * Keeps a file the calling thread named, if its own layout lets it read that path. A
   * `scratch` path is relative to the caller's own folder unless it starts with the name of a
   * thread in the log; the event stores the full form.
   */
  const keep = async (
    c: Caller,
    taskId: string,
    f: Pick<EvidenceRef, "root" | "path">,
  ): Promise<EvidenceRef> => {
    const ownName = parseThreadId(runId, c.threadId).name;
    const file =
      f.root === "scratch" && !log().threads.has(`${runId}.${f.path.split("/")[0]}`)
        ? { root: f.root, path: `${ownName}/${f.path}` }
        : { root: f.root, path: f.path };
    const path = pathOf(taskId, file);
    const layout = layoutOf(c.threadId, (p) => cites(taskId, p));
    try {
      layout.keyOf(path, "read");
    } catch (error) {
      throw new Refusal(
        `Evidence ${path} is not a file you can read: ${error instanceof Error ? error.message : error}`,
      );
    }
    // Only a path the thread's sandbox mounts can be hashed there.
    const mounted = layout.mounts.some((m) => path.startsWith(`${m.path}/`));
    const hash = mounted ? () => sandboxHash(c.threadId, path, c.signal) : undefined;
    const sha256 = await evidence
      .keep(runId, taskId, file, { hash, signal: c.signal })
      .catch((error) => {
        if (error instanceof EvidenceRefused) throw new Refusal(error.message);
        if (error instanceof EvidenceNotFound) {
          throw new Refusal(
            `No file at ${path}. ${
              file.root === "outputs"
                ? `Cite an output file by its path inside /outputs/${taskId}/, e.g. {root: "outputs", path: "frame.json"}.`
                : `Cite a file in your working folder as {root: "scratch", path: <path inside $SCRATCH>}.`
            }`,
          );
        }
        if (error instanceof Refusal || c.signal.aborted) throw error;
        throw new Refusal(`could not keep ${f.path}; try again`);
      });
    return { ...file, sha256 };
  };

  const done = (message: string, eventId?: string): TaskToolResult => ({
    message,
    ...(eventId && { eventId }),
  });

  return {
    view,
    taskOf,
    cites,
    section,
    setStatus,
    openAttempt,
    stop,
    keep,

    /** Writes the run's first event, carrying the plan. A resumed run already has it. */
    start: () =>
      section(() =>
        recorder.append(
          rootThreadId,
          "revision.started",
          {
            reason: "run",
            plan: {
              tasks: [...options.plan],
            },
          },
          `${rootThreadId}:revision`,
        ),
      ),

    /**
     * The holder hands its task to the check: `task under-review` with the summary as its
     * reason. The caller ends its turn. Refused with other tools in the batch (the turn would
     * not end), while a required output is unreported, and while an output the previous attempt
     * reported is not reported again (`droppedOutputs`).
     */
    submitTask: (c: Caller, input: SubmitTaskInput) =>
      section(async () => {
        const { taskId, summary } = input;
        if (c.batchSize > 1) throw new Refusal("Call submit_task alone, not with other tools.");
        const target = writeTarget(c, taskId, { verdict: false, what: "submits tasks" });
        const missing = target.fresh
          ? known(taskId)
              .outputs.filter((o) => o.required)
              .map((o) => o.id)
          : (taskOf(taskId)?.missingRequired ?? []);
        if (missing.length > 0) {
          throw new Refusal(
            `${taskId} cannot be submitted: required outputs not reported: ${missing.join(", ")}. Report them with report_output, or report them missing with the reason.`,
          );
        }
        const dropped = droppedOutputs(taskId, target.fresh);
        if (dropped.length > 0) {
          throw new Refusal(
            `${taskId} cannot be submitted: the previous attempt of ${taskId} reported ${dropped.join(", ")}, and this one has not. Report each again with report_output, or report it missing with the reason (a measurement: value null with the reason).`,
          );
        }
        const id = effectId("submit_task", c.threadId, c.toolCallId);
        await setStatus(
          c.threadId,
          id,
          taskId,
          await target.attempt(),
          "under-review",
          summary,
          AGENT,
        );
        return done(`${taskId} is submitted for checking. Your turn ends here.`, id);
      }),

    /** A check thread's question to the main agent; it ends its turn and the answer resumes it. */
    ask: (c: Caller, input: AskInput) =>
      section(async () => {
        if (c.kind !== "check" || !c.taskId) throw new Refusal("Only a check thread asks.");
        if (c.batchSize > 1) throw new Refusal("Call ask alone, not with other tools.");
        writeTarget(c, c.taskId, { verdict: false, what: "asks" });
        const asked = log().threads.get(c.threadId)?.asks.length ?? 0;
        if (asked >= MAX_ASKS) {
          throw new Refusal(`You have asked ${MAX_ASKS} questions; give your verdict now.`);
        }
        const id = effectId("ask", c.threadId, c.toolCallId);
        await recorder.append(c.threadId, "ask", { question: input.question }, id);
        return done("Question sent. Your turn ends here; the answer resumes you.", id);
      }),

    checkpoint: (c: Caller, input: CheckpointInput) => {
      const { taskId, text, summary, verdict, toCheck } = input;
      return write(
        () =>
          writeTarget(c, taskId, {
            verdict: verdict !== undefined,
            what: "writes checkpoints",
          }),
        () => Promise.all(input.evidence.map((f) => keep(c, taskId, f))),
        async (target, refs) => {
          const id = effectId("checkpoint", c.threadId, c.toolCallId);
          await recorder.append(
            c.threadId,
            "checkpoint",
            {
              taskId,
              attemptId: await target.attempt(),
              text,
              summary,
              by: AGENT,
              evidence: refs,
              ...(verdict && { verdict }),
              ...(toCheck && { toCheck }),
            },
            id,
          );
          return done("Checkpoint recorded.", id);
        },
      );
    },

    reportOutput: (c: Caller, input: ReportOutputInput) => {
      const { taskId, outputId, title, output } = input;
      const target = () => {
        if (c.kind === "check") {
          throw new Refusal(
            "A check thread does not report outputs: put the values you re-derived in your checkpoint's text.",
          );
        }
        const t = writeTarget(c, taskId, { verdict: false, what: "reports outputs" });
        const declared = known(taskId).outputs.find((o) => o.id === outputId);
        const problem =
          declarationProblem(declared, { title, output }) ??
          referenceProblem(view(), taskId, output) ??
          placementProblem(view(), planNow(), { outputId, output });
        if (problem) throw new Refusal(problem);
        return t;
      };
      // Files first, outside the section: a missing one fails the call before anything is
      // appended, and a copy does not hold up the run's other task writes.
      const prepare = async () => ({
        evidenceRefs: await Promise.all(input.evidence.map((f) => keep(c, taskId, f))),
        output: await storedOutput(output, (f) => keep(c, taskId, f)),
      });
      return write(target, prepare, async (t, prepared) => {
        const attemptId = await t.attempt();
        const id = effectId("report_output", c.threadId, c.toolCallId);
        await recorder.append(
          c.threadId,
          "output",
          {
            taskId,
            attemptId,
            outputId,
            title,
            evidence: prepared.evidenceRefs,
            output: prepared.output,
          },
          id,
        );
        return done(`Output ${outputId} recorded.`, id);
      });
    },
  };
}

export type TaskRuntime = ReturnType<typeof taskRuntime>;
