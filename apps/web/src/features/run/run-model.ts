/**
 * The run page's data, derived with no React from the run's events and state: the threads
 * (main agent, workers, checks) with what each is doing now, and per plan task where it stands,
 * what the AI did, the second AI check's verdict, its To check items (open or accepted), its QC
 * image and its values. Built on `reviewState` (the shared fold plus accepted checks), so it
 * agrees with the review. Transcripts are in `transcript.ts`.
 */
import type { RunEvent } from "@voluma/contracts/events";
import type { FoldedTask } from "@voluma/contracts/fold";
import type { Asset } from "@voluma/contracts/review";
import { reviewState } from "@voluma/contracts/review-state";
import type { ProviderCalls, RunState } from "@voluma/contracts/run";
import { type RunSpend, type Spend, spend } from "@voluma/contracts/spend";
import { runningThreads } from "@voluma/contracts/threads";
import { isSatisfied } from "@voluma/workflow";
import { catalog } from "@voluma/workflow/bundled";
import { type Halt, type Live, toolTitle } from "./transcript";

const { outputName, taskTitle } = catalog["mouse-oa"];

/** `paused`: open while the run waits for a runner or keys; it resumes with a `thread.started`. */
export type ThreadStatus = "running" | "paused" | "completed" | "failed" | "cancelled";

export type Thread = {
  id: string;
  kind: "supervisor" | "main" | "worker" | "check" | "chat";
  taskId?: string;
  model?: string;
  /** Its latest start: a resumed thread's clock counts from its resume. */
  startedAt: string;
  /** Where its clock stops: its end, the run's end, or its last event while paused. */
  endedAt?: string;
  status: ThreadStatus;
  error?: string;
  toolCalls: number;
  toolErrors: number;
  /** A worker's or checker's own cost and time; the run's spend has the main thread's. */
  spend?: Spend;
  /** The tool call running now, by title; else the last one it made. */
  liveTool?: string;
  lastTool?: string;
  /** The thread's last checkpoint, and its verdict for a checker. */
  result?: { text: string; verdict?: "passed" | "needs-review" };
  /** Its last prose, the report a finished card expands to. */
  said?: string;
};

/**
 * When the runner is not running the run's threads (see `Halt`). A queued run with no threads
 * open is paused too, which changes nothing.
 */
export function haltOf(state: RunState): Halt | undefined {
  switch (state.status) {
    case "running":
      return undefined;
    case "queued":
    case "awaiting-keys":
      return { kind: "paused" };
    case "ended":
      return { kind: "ended", at: state.endedAt, outcome: state.outcome };
  }
}

/**
 * Every thread the run has started, in start order, as the log tells it; `halted` applies what
 * the log can't say.
 */
function threadsOf(events: RunEvent[]): { threads: Thread[]; lastAt: Map<string, string> } {
  const threads = new Map<string, Thread>();
  const running = new Map<string, Map<string, string>>();
  const lastAt = new Map<string, string>();
  const own = new Map<string, RunEvent[]>();
  for (const e of events) {
    const t = threads.get(e.threadId);
    lastAt.set(e.threadId, e.createdAt);
    const mine = own.get(e.threadId);
    if (mine) mine.push(e);
    else own.set(e.threadId, [e]);
    switch (e.type) {
      case "thread.started":
        if (t) {
          t.status = "running";
          t.startedAt = e.createdAt;
          t.endedAt = undefined;
        } else
          threads.set(e.threadId, {
            id: e.threadId,
            kind: e.payload.kind,
            taskId: e.payload.task,
            model: e.payload.model,
            startedAt: e.createdAt,
            status: "running",
            toolCalls: 0,
            toolErrors: 0,
          });
        break;
      case "thread.ended":
        if (t) {
          t.status = e.payload.status;
          t.error = e.payload.error;
          t.endedAt = e.createdAt;
          running.delete(e.threadId);
        }
        break;
      case "tool.call":
        if (t) {
          t.toolCalls++;
          const calls = running.get(e.threadId) ?? new Map<string, string>();
          t.lastTool = toolTitle(e.payload.name, e.payload.input);
          calls.set(e.payload.toolCallId, t.lastTool);
          running.set(e.threadId, calls);
        }
        break;
      case "tool.result":
        if (t) {
          if (e.payload.isError) t.toolErrors++;
          running.get(e.threadId)?.delete(e.payload.toolCallId);
        }
        break;
      case "checkpoint":
        if (t) t.result = { text: e.payload.text, verdict: e.payload.verdict };
        break;
      case "message":
        if (t && e.payload.role === "assistant" && e.payload.text) t.said = e.payload.text;
        break;
    }
  }
  for (const t of threads.values()) {
    if (t.status === "running") t.liveTool = [...(running.get(t.id)?.values() ?? [])].at(-1);
    // `spend` over one worker's or checker's events counts them all for its task, so that one
    // task's spend is the thread's own.
    if (t.kind === "worker" || t.kind === "check")
      t.spend = spend(own.get(t.id) ?? []).tasks[0]?.spend;
  }
  return { threads: [...threads.values()], lastAt };
}

/**
 * A thread still open when it is not running (`runningThreads`): a lost runner writes no end.
 * A cancel ends every thread in the API, so only a failed run leaves them here. It is stopped (failed, if the run failed)
 * at the run's end, or paused at its last event while the run waits to resume.
 */
function halted(
  threads: Thread[],
  lastAt: Map<string, string>,
  halt: Halt,
  running: ReadonlySet<string>,
): Thread[] {
  return threads.map((t) =>
    t.status !== "running" || running.has(t.id)
      ? t
      : halt.kind === "ended"
        ? {
            ...t,
            status: halt.outcome === "failed" ? "failed" : "cancelled",
            endedAt: halt.at,
            liveTool: undefined,
          }
        : { ...t, status: "paused", endedAt: lastAt.get(t.id), liveTool: undefined },
  );
}

/** Threads with a tool call still being written and none running say so; others are kept as is. */
export function withLiveCalls(threads: Thread[], live: Live): Thread[] {
  const writing = new Set([...live.calls.values()].map((c) => c.threadId));
  if (writing.size === 0) return threads;
  return threads.map((t) =>
    t.status === "running" && !t.liveTool && writing.has(t.id)
      ? { ...t, liveTool: "Writing a tool call…" }
      : t,
  );
}

/** "Segmentation: the AI's work", "Segmentation: second AI check", "Lead AI". */
export const threadName = (t: Pick<Thread, "kind" | "taskId">) =>
  t.kind === "worker" && t.taskId
    ? `${taskTitle(t.taskId)}: the AI's work`
    : t.kind === "check" && t.taskId
      ? `${taskTitle(t.taskId)}: second AI check`
      : t.kind === "chat"
        ? "Chat"
        : "Lead AI";

export type TaskState =
  /** Not started, and a task it builds on has no usable result yet. */
  | "waiting"
  /** Not started, and every task it builds on has a usable result (`isSatisfied`). */
  | "ready"
  | "running"
  /** A second AI is checking the result. */
  | "checking"
  | "done"
  | "to-check"
  /** Skipped by the plan, or builds on a skipped task. */
  | "skipped"
  | "failed"
  /** Working or being checked when the run ended. */
  | "stopped"
  /** Working or being checked while the run waits for a runner or keys. */
  | "paused";

/** One To check item, open or accepted: what the review would show for it. */
export type NeedItem = {
  /** The check's id (`acceptCheck`). */
  id: string;
  taskId: string;
  title: string;
  /** What is wrong, in the checkpoint's researcher sentence when it has one. */
  text: string;
  image?: Asset;
  accepted: boolean;
  /**
   * A check item "Looks right" can accept. A task left To check with no item (its check sent it
   * back, or a required value is missing) still needs the researcher, with nothing to accept.
   */
  acceptable: boolean;
};

/** One value in a task's results. */
export type ResultRow = {
  id: string;
  title: string;
  /** "0.824", a score's level; null when there is none. */
  value: string | null;
  unit: string;
  /** Why there is no value, or why a shown one may no longer hold. */
  note?: string;
};

export type TaskView = {
  id: string;
  title: string;
  /** 1-based, in plan order. */
  number: number;
  dependsOn: string[];
  state: TaskState;
  /** This task's worker and check threads, in start order; a redo adds a worker. */
  threads: Thread[];
  /** Its newest thread: its clock while it works. */
  latest?: Thread;
  /** More than one worker attempt: the result was sent back and redone. */
  redone: boolean;
  /** What the AI did: the current attempt's latest worker checkpoint, its summary first. */
  did?: string;
  /** The second AI check's verdict on the current attempt. */
  check?: { verdict: "passed" | "needs-review"; text: string };
  /** The fold's `rejected`: the check sent the result back. */
  rejected: boolean;
  /** Why it failed or was skipped. */
  reason?: string;
  needs: NeedItem[];
  image?: Asset;
  results: ResultRow[];
  /** The plan declares a measurement or score for it: it has a place in Results. */
  valued: boolean;
  /** Its latest result came from a correction. */
  corrected: boolean;
  /** While waiting: the tasks it builds on that have no usable result yet. */
  waitingOn: string[];
  spend?: Spend;
};

const isImage = (a: Asset) => /\.(jpe?g|png)$/i.test(a.name);

const SUPERSCRIPT: Record<string, string> = { "^2": "²", "^3": "³", "^-1": "⁻¹" };

/** "mm³" from "mm^3"; "" for a dimensionless "1". */
const unitText = (unit: string) =>
  unit === "1" ? "" : unit.replace(/\^-?\d/g, (p) => SUPERSCRIPT[p] ?? p);

/** Up to three significant digits (whole numbers from 1,000). */
const formatNumber = (value: number) =>
  new Intl.NumberFormat("en-US", {
    ...(Math.abs(value) >= 1000 ? { maximumFractionDigits: 0 } : { maximumSignificantDigits: 3 }),
  }).format(value);

/**
 * A task's values: each measurement and score of the current attempt (files, volumes,
 * structures and annotations have no value to read here; the review shows them), then, once
 * the task has finished, each required one it never reported.
 */
function resultRows(t: FoldedTask, state: TaskState): ResultRow[] {
  const rows: ResultRow[] = [
    ...t.measurements.map((m) => ({
      id: m.id,
      title: m.title ?? m.id,
      value: m.value === null ? null : formatNumber(m.value),
      unit: unitText(m.unit),
      ...(m.value === null && { note: m.note ?? "No value given" }),
    })),
    ...t.scores.map((s) => ({ id: s.id, title: s.title ?? s.id, value: s.level, unit: "" })),
  ];
  // A task made stale by a change upstream keeps its old attempt until it is redone.
  if (t.status === "stale")
    for (const r of rows) if (r.value !== null) r.note = "May no longer hold: redone upstream";
  if (state === "done" || state === "to-check" || state === "failed" || state === "skipped")
    for (const m of t.missing)
      if (m.required && (m.kind === "measurement" || m.kind === "score"))
        rows.push({
          id: `${t.id}/${m.outputId}`,
          title: outputName(m.outputId),
          value: null,
          unit: "",
          note: m.reason ?? "Not reported",
        });
  return rows;
}

/** The card for a task left To check with no check item: why it is there, in plain words. */
function unexplained(
  t: FoldedTask,
  checkText: string | undefined,
  image: Asset | undefined,
): NeedItem {
  const base = { id: `${t.id}/to-check`, taskId: t.id, image, accepted: false, acceptable: false };
  if (t.rejected || t.checker?.verdict === "needs-review")
    return { ...base, title: "Sent back by the second AI", text: checkText ?? t.reason ?? "" };
  if (t.missingRequired.length > 0)
    return {
      ...base,
      title: "Values missing",
      text: `Not reported: ${t.missingRequired.map(outputName).join(", ")}.`,
    };
  return { ...base, title: "To check", text: t.reason ?? "" };
}

function stateOf(
  t: FoldedTask | undefined,
  blocked: boolean,
  working: boolean,
  halt: Halt | undefined,
): TaskState {
  const status = t?.status;
  const state: TaskState = t?.skipped
    ? "skipped"
    : status === "in-progress" ||
        ((status === undefined || status === "pending" || status === "stale") && working)
      ? "running"
      : status === "under-review"
        ? "checking"
        : status === "done" || status === "to-check" || status === "failed"
          ? status
          : blocked
            ? "waiting"
            : "ready";
  if (halt && (state === "running" || state === "checking"))
    return halt.kind === "ended" ? "stopped" : "paused";
  return state;
}

export type RunView = {
  /** Without the tool calls still being written: `withLiveCalls` adds those per frame. */
  threads: Thread[];
  /** One per plan task, in plan order; empty until the run has a plan. */
  tasks: TaskView[];
  /** Tasks done or to check, of all. */
  done: number;
  /** Open To check items. */
  toCheck: number;
  spend: RunSpend;
  /** The lead AI's own thread has started (runs before the main agent had none). */
  hasLead: boolean;
};

/** Everything the run page shows about the run, from its durable events and state. */
export function runView(
  events: RunEvent[],
  state: RunState,
  providerCalls: ProviderCalls | undefined,
): RunView {
  const logged = threadsOf(events);
  const halt = haltOf(state);
  const running = runningThreads(events, state);
  const threads = halt ? halted(logged.threads, logged.lastAt, halt, running) : logged.threads;
  const spent = spend(events, providerCalls);
  const hasLead = threads.some((t) => t.kind === "main");
  // No plan until the run's first `revision.started`.
  const latest = reviewState(events).revisions.at(-1);
  if (!latest) return { threads, tasks: [], done: 0, toCheck: 0, spend: spent, hasLead };

  const byId = new Map(latest.tasks.map((t) => [t.id, t]));
  // Checkpoints by event id: their researcher sentence, and the thread that wrote them.
  const summaries = new Map<string, string>();
  const writer = new Map<string, string>();
  for (const e of events)
    if (e.type === "checkpoint") {
      writer.set(e.id, e.threadId);
      if (e.payload.summary) summaries.set(e.id, e.payload.summary);
    }
  const working = new Set(
    logged.threads.flatMap((t) =>
      t.kind === "worker" && running.has(t.id) && t.taskId ? [t.taskId] : [],
    ),
  );
  const taskSpend = new Map(spent.tasks.map((t) => [t.taskId, t.spend]));
  const corrections = new Set(
    events.flatMap((e) =>
      e.type === "revision.started" && e.payload.reason === "correction" ? [e.id] : [],
    ),
  );

  const tasks = latest.plan.tasks.map((p, i): TaskView => {
    const t = byId.get(p.id);
    const blocked = p.dependsOn.some((d) => !isSatisfied(byId.get(d)));
    const state = stateOf(t, blocked, working.has(p.id), halt);
    const own = threads.filter((th) => th.taskId === p.id);
    const assets = new Map((t?.evidence ?? []).map((a) => [a.id, a]));
    const imageOf = (ids: string[]) =>
      ids.map((id) => assets.get(id)).find((a): a is Asset => a !== undefined && isImage(a));
    const fromWorker = t?.milestones.filter((m) => writer.get(m.id) === t.threads.worker) ?? [];
    const lastWorker = fromWorker.at(-1);
    const image =
      [...fromWorker]
        .reverse()
        .map((m) => imageOf(m.evidenceIds))
        .find(Boolean) ?? [...(t?.evidence ?? [])].reverse().find(isImage);
    const lastVerdict = t?.milestones.filter((m) => m.verdict).at(-1);
    return {
      id: p.id,
      title: p.title ?? taskTitle(p.id),
      number: i + 1,
      dependsOn: p.dependsOn,
      state,
      threads: own,
      latest: own.at(-1),
      redone: own.filter((th) => th.kind === "worker").length > 1,
      did: lastWorker && (summaries.get(lastWorker.id) ?? lastWorker.text),
      check:
        t?.checker && lastVerdict
          ? {
              verdict: t.checker.verdict,
              text: summaries.get(lastVerdict.id) ?? t.checker.text,
            }
          : undefined,
      rejected: Boolean(t?.rejected),
      reason: state === "failed" || state === "skipped" ? (t?.reason ?? undefined) : undefined,
      needs:
        t?.status !== "to-check"
          ? []
          : t.checks.length > 0
            ? t.checks.map((c) => ({
                id: c.id,
                taskId: p.id,
                title: c.title,
                text: summaries.get(c.id) ?? c.detail,
                image: imageOf(t.milestones.find((m) => m.id === c.id)?.evidenceIds ?? []) ?? image,
                accepted: c.status === "accepted",
                acceptable: true,
              }))
            : [
                unexplained(
                  t,
                  lastVerdict && (summaries.get(lastVerdict.id) ?? lastVerdict.text),
                  image,
                ),
              ],
      image,
      results: t ? resultRows(t, state) : [],
      valued: p.outputs.some((o) => o.kind === "measurement" || o.kind === "score"),
      corrected: Boolean(t && corrections.has(t.resultRevisionId)),
      waitingOn: state === "waiting" ? p.dependsOn.filter((d) => !isSatisfied(byId.get(d))) : [],
      spend: taskSpend.get(p.id),
    };
  });
  return {
    threads,
    tasks,
    done: tasks.filter((t) => t.state === "done" || t.state === "to-check").length,
    toCheck: tasks.reduce((n, t) => n + t.needs.filter((c) => !c.accepted).length, 0),
    spend: spent,
    hasLead,
  };
}
