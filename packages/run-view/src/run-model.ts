/**
 * A run's data, derived with no React from the run's events and state: the threads
 * (main agent, workers, checks) with what each is doing now, and per plan task where it stands,
 * what the AI did, the second AI check's verdict, its To check items (open or accepted), its QC
 * image and its values. Built on `reviewState` (the shared fold plus accepted checks), so it
 * agrees with the review. Transcripts are in `transcript.ts`.
 */
import type { RunEvent } from "@voluma/contracts/events";
import { abandonedEvents, type FoldedTask } from "@voluma/contracts/fold";
import type { TaskState } from "@voluma/contracts/ids";
import type { Asset, Unacceptable } from "@voluma/contracts/review";
import {
  cardWithoutCheck,
  progress,
  reviewState,
  taskStates,
} from "@voluma/contracts/review-state";
import type { ProviderCalls, RunState } from "@voluma/contracts/run";
import { type RunSpend, type Spend, spend } from "@voluma/contracts/spend";
import { type ThreadPlace, threadPlace } from "@voluma/contracts/thread-place";
import { failedThreads, openThreads } from "@voluma/contracts/threads";
import { catalog } from "@voluma/workflow/bundled";
import { plainError } from "./run-error";
import { type Halt, type Live, toolTitle } from "./transcript";

const { outputName, taskTitle, tasks: workflowTasks } = catalog["mouse-oa"];

/** What each task is for, from `tasks.json`: a working task's line until its AI says more. */
const purpose = new Map(workflowTasks.map((t) => [t.id, t.summary]));

/**
 * `waiting`: open while the run waits in line for a runner; `paused`: while it waits for its
 * starter's keys. Either resumes with a `thread.started`.
 */
export type ThreadStatus = "running" | "waiting" | "paused" | "completed" | "failed" | "cancelled";

export type Thread = {
  id: string;
  /** From its first start (`threadPlace`). */
  place: ThreadPlace;
  /** The role file's name or `supervisor`: a label (`agentLabel`); behaviour reads the fields below. */
  kind: string;
  /** The thread that started it, from its `thread.started`; null on the run's root. */
  parentId: string | null;
  taskId?: string;
  /** A check's: the attempt it checks. */
  attemptId?: string;
  /** The attempts it opened, in order (`attempt.opened` ids): a redo resumes the same thread. */
  attempts: string[];
  model?: string;
  /** Seconds it worked in its spans that ended (`spend`'s `endedSeconds`). */
  endedSeconds: number;
  /** When its span still open began (`spend`'s `openSince`): the clock runs from here. */
  openSince: string | null;
  /**
   * Where the open span's clock stops while the runner isn't running the run (`halted`): the
   * run's end, or the thread's last event while paused. `openSince` stays set on a thread cut
   * off this way, since the log never ended it.
   */
  stoppedAt?: string;
  status: ThreadStatus;
  error?: string;
  toolCalls: number;
  toolErrors: number;
  /** A worker's or checker's own cost and time (`spend().threads`); the run's spend has the main thread's. */
  spend?: Spend;
  /** The tool call running now, by title; else the last one it made. */
  liveTool?: string;
  lastTool?: string;
  /**
   * The thread's last checkpoint in the researcher's words (its `summary`; its `text` when it has
   * none), and its verdict for a checker.
   */
  result?: { text: string; verdict?: "passed" | "needs-review" };
  /** Its last prose, the report a finished card expands to. */
  said?: string;
};

/**
 * When the runner is not running the run's threads (see `Halt`). A queued run with no threads
 * open is waiting too, which changes nothing. An ended run halts only once its stream has
 * `closed`: until then its log may still be loading, and a thread open in the part loaded so
 * far may have ended in the rest.
 */
export function haltOf(state: RunState, closed: boolean): Halt | undefined {
  switch (state.status) {
    case "running":
      return undefined;
    case "queued":
      return { kind: "waiting" };
    case "awaiting-keys":
      return { kind: "paused" };
    case "ended":
      return closed ? { kind: "ended", at: state.endedAt, outcome: state.outcome } : undefined;
  }
}

/**
 * Every thread the run has started, in start order, as the log tells it; `halted` applies what
 * the log can't say.
 */
function threadsOf(
  events: RunEvent[],
  spent: RunSpend,
): { threads: Thread[]; lastAt: Map<string, string> } {
  const threads = new Map<string, Thread>();
  const running = new Map<string, Map<string, string>>();
  const lastAt = new Map<string, string>();
  for (const e of events) {
    const t = threads.get(e.threadId);
    lastAt.set(e.threadId, e.createdAt);
    switch (e.type) {
      case "thread.started":
        if (t) t.status = "running";
        else
          threads.set(e.threadId, {
            id: e.threadId,
            place: threadPlace(e.payload),
            kind: e.payload.kind,
            parentId: e.payload.parentThreadId,
            taskId: e.payload.task,
            attemptId: e.payload.attemptId,
            attempts: [],
            model: e.payload.model,
            endedSeconds: 0,
            openSince: null,
            status: "running",
            toolCalls: 0,
            toolErrors: 0,
          });
        break;
      case "thread.ended":
        if (t) {
          t.status = e.payload.status;
          t.error = e.payload.error;
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
          // A failure of Voluma's infrastructure isn't the agent's failed call.
          if (e.payload.isError && !e.payload.infrastructure) t.toolErrors++;
          running.get(e.threadId)?.delete(e.payload.toolCallId);
        }
        break;
      case "attempt.opened":
        t?.attempts.push(e.id);
        break;
      case "checkpoint":
        if (t) t.result = { text: e.payload.summary ?? e.payload.text, verdict: e.payload.verdict };
        break;
      case "message":
        if (t && e.payload.role === "assistant" && !e.payload.compaction && e.payload.text)
          t.said = e.payload.text;
        break;
    }
  }
  const clock = new Map(spent.threads.map((s) => [s.threadId, s]));
  for (const t of threads.values()) {
    if (t.status === "running") t.liveTool = [...(running.get(t.id)?.values() ?? [])].at(-1);
    const c = clock.get(t.id);
    if (c) {
      t.endedSeconds = c.endedSeconds;
      t.openSince = c.openSince;
      if (t.taskId) t.spend = c.spend;
    }
  }
  return { threads: [...threads.values()], lastAt };
}

/**
 * A thread still open when the runner is not running the run (`halt`): a lost runner writes no
 * end. A cancel ends every thread in the API, so only a failed run leaves them here. It is stopped
 * (failed, if the run failed) at the run's end, or waiting (paused, for keys) at its last event while the run waits to resume.
 */
function halted(threads: Thread[], lastAt: Map<string, string>, halt: Halt): Thread[] {
  return threads.map((t) =>
    t.status !== "running"
      ? t
      : halt.kind === "ended"
        ? {
            ...t,
            status: halt.outcome === "failed" ? "failed" : "cancelled",
            stoppedAt: halt.at,
            liveTool: undefined,
          }
        : { ...t, status: halt.kind, stoppedAt: lastAt.get(t.id), liveTool: undefined },
  );
}

/** Seconds a thread has worked by `now` (ms): its ended spans, and its open one up to its stop or now. */
export function workedSeconds(t: Thread, now: number): number {
  if (!t.openSince) return t.endedSeconds;
  const end = t.stoppedAt ? Date.parse(t.stoppedAt) : now;
  return t.endedSeconds + Math.max(0, end - Date.parse(t.openSince)) / 1000;
}

/**
 * The spans a run worked: its first claim to its end, then each correction from its
 * `run.reopened` to the root thread's next end or its `correction.ended`. The time between an
 * end and a researcher's reopen is not work. The last span runs to the run's end, or to `now`
 * while the run goes. A run queued again after a reopen or a lost runner has no `startedAt` in its
 * state, so the first claim comes from the log. `redos` counts the corrections that redid a task
 * (a reopen can end with only a reply); `reopens` every message that reopened it.
 */
export function runWork(
  events: readonly RunEvent[],
  state: RunState,
  now: number,
): { startedAt: string; seconds: number; redos: number; reopens: number } | undefined {
  const startedAt =
    (state.status === "queued" ? null : state.startedAt) ??
    events.find((e) => e.type === "claim.started")?.createdAt;
  if (!startedAt) return undefined;
  const roots = new Set<string>();
  const starts = [Date.parse(startedAt)];
  const ends: (number | undefined)[] = [];
  let redos = 0;
  for (const e of events) {
    if (e.type === "thread.started" && e.payload.parentThreadId === null) roots.add(e.threadId);
    else if (e.type === "run.reopened") starts.push(Date.parse(e.createdAt));
    else if (e.type === "revision.started" && e.payload.reason === "correction") redos += 1;
    else if ((e.type === "thread.ended" && roots.has(e.threadId)) || e.type === "correction.ended")
      // The latest end inside a span closes it: a resumed root can end more than once.
      ends[starts.length - 1] = Date.parse(e.createdAt);
  }
  const last = state.status === "ended" ? Date.parse(state.endedAt) : now;
  let seconds = 0;
  starts.forEach((start, i) => {
    const end =
      i === starts.length - 1 && state.status !== "ended"
        ? last
        : (ends[i] ?? starts[i + 1] ?? last);
    seconds += Math.max(0, end - start) / 1000;
  });
  return { startedAt, seconds, redos, reopens: starts.length - 1 };
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

export const isMain = (t: Pick<Thread, "place">) => t.place === "main";

export const isCheck = (t: Pick<Thread, "place"> | undefined) => t?.place === "check";

export type AgentNode = { thread: Thread; children: AgentNode[] };

/**
 * The run's agents as the log places them: each under the thread that started it
 * (`parentThreadId`), in start order. The supervisor runs no model, so its children are the roots.
 * Nothing here knows the kinds, so a new kind or a nested helper appears with no change.
 */
export function agentTree(threads: Thread[]): AgentNode[] {
  const nodes = new Map(
    threads.filter((t) => t.parentId !== null).map((t) => [t.id, { thread: t, children: [] }]),
  );
  const roots: AgentNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.thread.parentId ? nodes.get(node.thread.parentId) : undefined;
    (parent ? parent.children : roots).push(node);
  }
  return roots;
}

/**
 * An agent's name where its task is already shown: "The AI's work", "Second AI check, try 2",
 * "Lead AI". A check is numbered by its `attemptId`'s place among its worker's attempts once there are
 * two; how many tries the worker took is in its info (`ThreadInfo`). `short`, for a narrow place
 * beside its outcome: "Second check", "Second check, try 2".
 */
export function agentLabel(t: Thread, threads: Thread[], { short = false } = {}): string {
  switch (t.kind) {
    case "main":
      return "Lead AI";
    case "worker":
      return "The AI's work";
    case "check": {
      const attemptId = t.attemptId;
      const tries = attemptId
        ? threads.find((w) => w.attempts.includes(attemptId))?.attempts
        : undefined;
      const n = tries && attemptId ? tries.indexOf(attemptId) + 1 : 0;
      if (!tries || tries.length < 2) return short ? "Second check" : "Second AI check";
      // A no-break space keeps the number with its word when a narrow box wraps the name.
      return short ? `Second check, try\u00a0${n}` : `Second AI check, try\u00a0${n}`;
    }
    default:
      return "Agent";
  }
}

/** An agent's name anywhere: "Segmentation: Second AI check, try 2", "Lead AI". */
export const agentTitle = (t: Thread, threads: Thread[]) =>
  t.taskId ? `${taskTitle(t.taskId)}: ${agentLabel(t, threads)}` : agentLabel(t, threads);

/** Each role's name in `runModels`, in `agentLabel`'s words; the root records no model. */
const MODEL_ROLE = { main: "lead AI", worker: "tasks", check: "second checks" } as const;

/**
 * Which models a run calls, as label and ids: one "Model" row when every agent uses the same,
 * else a row per role ("Models (tasks)"); none before an agent records one. Every role lists
 * its ids in the run's first-seen order, so a model shared by two roles lines up in both.
 */
export function runModels(threads: Thread[]): { label: string; models: string[] }[] {
  const all = [...new Set(threads.flatMap((t) => (t.model ? [t.model] : [])))];
  if (all.length < 2) return all.map((m) => ({ label: "Model", models: [m] }));
  return Object.entries(MODEL_ROLE).flatMap(([place, role]) => {
    const used = new Set(threads.filter((t) => t.place === place).map((t) => t.model));
    const models = all.filter((m) => used.has(m));
    if (models.length === 0) return [];
    return [{ label: `${models.length > 1 ? "Models" : "Model"} (${role})`, models }];
  });
}

/** Where a task stands: the one rule the study shares (`taskStates`, contracts). */
export type { TaskState };

/** One To check item, open or accepted: what the review would show for it. */
export type NeedItem = {
  /** The check's id (`acceptCheck`). */
  id: string;
  taskId: string;
  /** The task result this item describes; decisions must not substitute a fresher result. */
  resultRevisionId: string;
  /** None for the fold's generic "Marked to check": the task's name says as much. */
  title?: string;
  /** What is wrong, in the checkpoint's researcher sentence when it has one. */
  text: string;
  /** The second AI check's full text, behind "What it found". */
  found?: string;
  image?: Asset;
  accepted: boolean;
  /**
   * A check item "Looks right" can accept; "K items to check" counts these (`progress`). A task left
   * To check with no item (its check sent it back, or a required value is missing) still gets
   * a card, with nothing to accept.
   */
  acceptable: boolean;
};

/** One value in a task's results. */
export type ResultRow = {
  id: string;
  /** The workflow's name for it (`outputs.json`); the AI's title for an output it doesn't list. */
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
  /** Its current attempt redoes one the second AI check sent back. */
  redone: boolean;
  /** What the AI did: the `summary` of the current attempt's latest worker checkpoint. */
  did?: string;
  /** What the task is for (`tasks.json`): its line while working, until `did` says more. */
  purpose?: string;
  /**
   * The second AI check's verdict on the current attempt: the milestone that holds it (`id`, also a
   * To check item's id when the verdict is the item), its sentence, and its full text.
   */
  check?: { id: string; verdict: "passed" | "needs-review"; summary?: string; text: string };
  /** The fold's `rejected`: the check sent the result back. */
  rejected: boolean;
  /** Why it failed or was skipped, task ids named by their titles. */
  reason?: string;
  needs: NeedItem[];
  image?: Asset;
  results: ResultRow[];
  /** The plan declares a measurement or score for it: it has a place in Results. */
  valued: boolean;
  /** Its latest result came from a correction. */
  corrected: boolean;
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
  // The fold names a value `taskId/outputId`; the workflow names the output.
  const nameOf = (id: string, title: string | undefined) => {
    const output = id.slice(t.id.length + 1);
    const name = outputName(output);
    return name !== output ? name : (title ?? id);
  };
  const rows: ResultRow[] = [
    ...t.measurements.map((m) => ({
      id: m.id,
      title: nameOf(m.id, m.title),
      value: m.value === null ? null : formatNumber(m.value),
      unit: unitText(m.unit),
      ...(m.value === null && { note: m.note ?? "No value given" }),
    })),
    ...t.scores.map((s) => ({ id: s.id, title: nameOf(s.id, s.title), value: s.level, unit: "" })),
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

/** The title of a To check task's card without a check (`cardWithoutCheck`): why it is there. */
export const CARD_TITLE: Record<Unacceptable, string> = {
  "sent-back": "Sent back by the second AI",
  "values-missing": "Values missing",
  marked: "To check",
};

/** The item id of a task's card without a check, as `itemHref` opens it. */
export const cardId = (taskId: string) => `${taskId}/to-check`;

/** The card for a task left To check with no check item (`cardWithoutCheck`), in plain words. */
function unexplained(
  t: FoldedTask,
  why: Unacceptable,
  check: TaskView["check"],
  image: Asset | undefined,
): NeedItem {
  const base = {
    id: cardId(t.id),
    taskId: t.id,
    resultRevisionId: t.resultRevisionId,
    image,
    accepted: false,
    acceptable: false,
  };
  const title = CARD_TITLE[why];
  if (why === "sent-back")
    return {
      ...base,
      title,
      text: check?.summary ?? "The second AI check sent the result back.",
      found: check?.text,
    };
  if (why === "values-missing")
    return {
      ...base,
      title,
      text: `Not reported: ${t.missingRequired.map(outputName).join(", ")}.`,
    };
  return { ...base, title, text: t.reason ?? "" };
}

type RunView = {
  /** Without the tool calls still being written: `withLiveCalls` adds those per frame. */
  threads: Thread[];
  /** One per plan task, in plan order; empty until the run has a plan. */
  tasks: TaskView[];
  /** `progress` of the latest revision: tasks done of all, and the checks a person can accept. */
  progress: { done: number; total: number; acceptable: number };
  spend: RunSpend;
};

/** The fold's title for a To check flag set by a `task` event; the task's name says as much. */
const GENERIC_CHECK = "Marked to check";

/** Everything a run's screen shows about the run, from its durable events and state. */
export function runView(
  events: RunEvent[],
  state: RunState,
  providerCalls: ProviderCalls | undefined,
  halt: Halt | undefined,
): RunView {
  const spent = spend(events, providerCalls);
  const logged = threadsOf(events, spent);
  const threads = halt ? halted(logged.threads, logged.lastAt, halt) : logged.threads;
  // No plan until the run's first `revision.started`.
  const latest = reviewState(events, { live: true }).revisions.at(-1);
  if (!latest)
    return {
      threads,
      tasks: [],
      progress: { done: 0, total: 0, acceptable: 0 },
      spend: spent,
    };

  const byId = new Map(latest.tasks.map((t) => [t.id, t]));
  // The fold names an untitled task by its id; a plan recorded before titles has none.
  const planned = new Map(latest.plan.tasks.map((p) => [p.id, p.title]));
  const titleOf = (id: string) => planned.get(id) ?? taskTitle(id);
  // A dependent of a skipped task reads as the skipped task's own reason, under its title.
  const skipText = (t: FoldedTask) => {
    if (!t.skipped) return undefined;
    const from = byId.get(t.skipped.from);
    return t.skipped.from === t.id || !from?.skipped
      ? t.skipped.reason
      : `${titleOf(t.skipped.from)} was skipped: ${from.skipped.reason}`;
  };
  const loggedById = new Map(logged.threads.map((t) => [t.id, t]));
  // Checkpoints by event id: their researcher sentence, and the thread that wrote them.
  const summaries = new Map<string, string>();
  const writer = new Map<string, string>();
  const abandoned = abandonedEvents(events);
  for (const e of events)
    if (abandoned.has(e.id)) continue;
    else if (e.type === "checkpoint") {
      writer.set(e.id, e.threadId);
      if (e.payload.summary) summaries.set(e.id, e.payload.summary);
    }
  const states = taskStates(latest, {
    // An ended run's log may still be loading until its stream closes (`haltOf`): read it as
    // it stood while the run ran, not as ended.
    state: state.status === "ended" && !halt ? { status: "running" } : state,
    open: openThreads(events),
    failed: failedThreads(events),
  });
  const taskSpend = new Map(spent.tasks.map((t) => [t.taskId, t.spend]));
  const corrections = new Set(
    events.flatMap((e) =>
      e.type === "revision.started" && e.payload.reason === "correction" && !abandoned.has(e.id)
        ? [e.id]
        : [],
    ),
  );

  const tasks = latest.plan.tasks.map((p, i): TaskView => {
    const t = byId.get(p.id);
    // The fold gives every plan task a row, pending ones too.
    if (!t) throw new Error(`fold has no row for plan task ${p.id}`);
    // `taskStates` gives every plan task a state.
    const state = states.get(p.id) as TaskState;
    // The logged end, not `halted`'s: a thread cut off by a failed run didn't fail itself.
    const failedThread =
      state === "failed"
        ? [t.threads.worker, t.threads.check]
            .map((id) => (id ? loggedById.get(id) : undefined))
            .find((th) => th?.status === "failed")
        : undefined;
    const own = threads.filter((th) => th.taskId === p.id);
    const assets = new Map(t.evidence.map((a) => [a.id, a]));
    const imageOf = (ids: string[]) =>
      ids.map((id) => assets.get(id)).find((a): a is Asset => a !== undefined && isImage(a));
    const fromWorker = t.milestones.filter((m) => writer.get(m.id) === t.threads.worker);
    const lastWorker = fromWorker.at(-1);
    const image =
      [...fromWorker]
        .reverse()
        .map((m) => imageOf(m.evidenceIds))
        .find(Boolean) ?? [...t.evidence].reverse().find(isImage);
    const lastVerdict = t.milestones.filter((m) => m.verdict).at(-1);
    const check: TaskView["check"] =
      t.checker && lastVerdict
        ? {
            id: lastVerdict.id,
            verdict: t.checker.verdict,
            summary: summaries.get(lastVerdict.id),
            text: t.checker.text,
          }
        : undefined;
    const items: NeedItem[] = t.checks.map((c) => ({
      id: c.id,
      taskId: p.id,
      resultRevisionId: t.resultRevisionId,
      title: c.title === GENERIC_CHECK ? undefined : c.title,
      text: summaries.get(c.id) ?? skipText(t) ?? c.detail,
      image: imageOf(t.milestones.find((m) => m.id === c.id)?.evidenceIds ?? []) ?? image,
      accepted: c.status === "accepted",
      acceptable: true,
    }));
    const card = cardWithoutCheck(t);
    const reason =
      state === "skipped"
        ? skipText(t)
        : state === "failed"
          ? failedThread
            ? failedThread.error && plainError(failedThread.error)
            : t.reason
          : undefined;
    return {
      id: p.id,
      title: titleOf(p.id),
      number: i + 1,
      dependsOn: p.dependsOn,
      state,
      threads: own,
      latest: own.at(-1),
      redone: t.sentBack.some((a) => a !== t.attemptId),
      did: lastWorker && summaries.get(lastWorker.id),
      purpose: purpose.get(p.id),
      check,
      rejected: t.rejected,
      reason: reason ?? undefined,
      needs: card ? [unexplained(t, card, check, image)] : items,
      image,
      results: resultRows(t, state),
      valued: p.outputs.some((o) => o.kind === "measurement" || o.kind === "score"),
      corrected: corrections.has(t.resultRevisionId),
      spend: taskSpend.get(p.id),
    };
  });
  return { threads, tasks, progress: progress(latest), spend: spent };
}
