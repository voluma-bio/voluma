/**
 * The run page's data, derived with no React from the run's events and state: the threads
 * (main agent, workers, checks) with what each is doing now, and per plan task where it stands,
 * what the AI did, the second AI check's verdict, its To check items (open or accepted), its QC
 * image and its values. Built on `reviewState` (the shared fold plus accepted checks), so it
 * agrees with the review. Transcripts are in `transcript.ts`.
 */
import type { RunEvent } from "@voluma/contracts/events";
import type { FoldedTask } from "@voluma/contracts/fold";
import { abandonedEvents, isSatisfied } from "@voluma/contracts/fold";
import type { Asset } from "@voluma/contracts/review";
import { progress, reviewState } from "@voluma/contracts/review-state";
import type { ProviderCalls, RunState } from "@voluma/contracts/run";
import { type RunSpend, type Spend, spend } from "@voluma/contracts/spend";
import { openThreads } from "@voluma/contracts/threads";
import { catalog } from "@voluma/workflow/bundled";
import { type Halt, type Live, toolTitle } from "./transcript";

const { outputName, taskTitle, tasks: workflowTasks } = catalog["mouse-oa"];

/** What each task is for, from `tasks.json`: a working task's line until its AI says more. */
const purpose = new Map(workflowTasks.map((t) => [t.id, t.summary]));

/**
 * `paused`: open while the run waits for a runner or keys; it resumes with a `thread.started`.
 */
export type ThreadStatus = "running" | "paused" | "completed" | "failed" | "cancelled";

export type Thread = {
  id: string;
  kind: "supervisor" | "main" | "worker" | "check" | "chat";
  /** The thread that started it, from its `thread.started`; null on the run's root. */
  parentId: string | null;
  taskId?: string;
  /** A check's: the attempt it checks. */
  attemptId?: string;
  /** The attempts it opened, in order (`attempt.opened` ids): a redo resumes the same thread. */
  attempts: string[];
  model?: string;
  /** Its latest start: the clock's running part counts from here. */
  startedAt: string;
  /** Seconds it worked before its latest start (a resume after an end, a restart or a redo). */
  workedBefore: number;
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
 * open is paused too, which changes nothing. An ended run halts only once its stream has
 * `closed`: until then its log may still be loading, and a thread open in the part loaded so
 * far may have ended in the rest.
 */
export function haltOf(state: RunState, closed: boolean): Halt | undefined {
  switch (state.status) {
    case "running":
      return undefined;
    case "queued":
      return { kind: "paused" };
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
function threadsOf(events: RunEvent[]): { threads: Thread[]; lastAt: Map<string, string> } {
  const threads = new Map<string, Thread>();
  const running = new Map<string, Map<string, string>>();
  const lastAt = new Map<string, string>();
  const own = new Map<string, RunEvent[]>();
  for (const e of events) {
    const t = threads.get(e.threadId);
    const before = lastAt.get(e.threadId);
    lastAt.set(e.threadId, e.createdAt);
    const mine = own.get(e.threadId);
    if (mine) mine.push(e);
    else own.set(e.threadId, [e]);
    switch (e.type) {
      case "thread.started":
        if (t) {
          // The earlier part ran to its end or, cut off by a lost runner, to its last event.
          const until = t.endedAt ?? before ?? t.startedAt;
          t.workedBefore += Math.max(0, Date.parse(until) - Date.parse(t.startedAt)) / 1000;
          t.status = "running";
          t.startedAt = e.createdAt;
          t.endedAt = undefined;
        } else
          threads.set(e.threadId, {
            id: e.threadId,
            kind: e.payload.kind,
            parentId: e.payload.parentThreadId,
            taskId: e.payload.task,
            attemptId: e.payload.attemptId,
            attempts: [],
            model: e.payload.model,
            startedAt: e.createdAt,
            workedBefore: 0,
            status: "running",
            toolCalls: 0,
            toolErrors: 0,
          });
        break;
      case "thread.ended":
        if (t) {
          t.status = e.payload.status;
          t.error = e.payload.error;
          // A later cancel can invalidate finished work without adding working time.
          t.endedAt ??= e.createdAt;
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
 * A thread still open when the runner is not running the run (`halt`): a lost runner writes no
 * end. A cancel ends every thread in the API, so only a failed run leaves them here. It is stopped
 * (failed, if the run failed) at the run's end, or paused at its last event while the run waits to resume.
 */
function halted(threads: Thread[], lastAt: Map<string, string>, halt: Halt): Thread[] {
  return threads.map((t) =>
    t.status !== "running"
      ? t
      : halt.kind === "ended"
        ? {
            ...t,
            status: halt.outcome === "failed" ? "failed" : "cancelled",
            endedAt: halt.at,
            liveTool: undefined,
          }
        : { ...t, status: halt.kind, endedAt: lastAt.get(t.id), liveTool: undefined },
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

export type AgentNode = { thread: Thread; children: AgentNode[] };

/**
 * The run's agents as the log places them: each under the thread that started it
 * (`parentThreadId`), in start order. The supervisor runs no model, so its children are the roots.
 * Nothing here knows the kinds, so a new kind or a nested helper appears with no change.
 */
export function agentTree(threads: Thread[]): AgentNode[] {
  const nodes = new Map(
    threads.filter((t) => t.kind !== "supervisor").map((t) => [t.id, { thread: t, children: [] }]),
  );
  const roots: AgentNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.thread.parentId ? nodes.get(node.thread.parentId) : undefined;
    (parent ? parent.children : roots).push(node);
  }
  return roots;
}

/**
 * An agent's name where its task is already shown: "The AI's work, 2 tries", "Second AI check of
 * try 1", "Lead AI". A check's try is its `attemptId`'s place among its worker's attempts.
 */
export function agentLabel(t: Thread, threads: Thread[]): string {
  switch (t.kind) {
    case "main":
      return "Lead AI";
    case "worker":
      return t.attempts.length > 1 ? `The AI's work, ${t.attempts.length} tries` : "The AI's work";
    case "check": {
      const attemptId = t.attemptId;
      const tries = attemptId
        ? threads.find((w) => w.attempts.includes(attemptId))?.attempts
        : undefined;
      return tries && tries.length > 1 && attemptId
        ? `Second AI check of try ${tries.indexOf(attemptId) + 1}`
        : "Second AI check";
    }
    case "chat":
      return "Chat";
    default:
      return "Agent";
  }
}

/** An agent's name anywhere: "Segmentation: Second AI check of try 2", "Lead AI". */
export const agentTitle = (t: Thread, threads: Thread[]) =>
  t.taskId ? `${taskTitle(t.taskId)}: ${agentLabel(t, threads)}` : agentLabel(t, threads);

export type TaskState =
  /** Not started, and a task it builds on has no usable result yet. */
  | "waiting"
  /** Not started, and every task it builds on has a usable result (`isSatisfied`). */
  | "ready"
  /** An AI is working on it now. */
  | "running"
  /** A second AI is checking the result now. */
  | "checking"
  /** Started, and no AI is working on it or checking it: the lead AI decides what's next. */
  | "held"
  | "done"
  | "to-check"
  /** Skipped by the plan, or builds on a skipped task. */
  | "skipped"
  /** Failed, or its AI failed on the error that failed the run. */
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
  /** The second AI check's verdict on the current attempt: its sentence, and its full text. */
  check?: { verdict: "passed" | "needs-review"; summary?: string; text: string };
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
 * An error's first line with the provider's raw JSON response cut down to its message:
 * "meta API error (404): The model does not exist". A body with no message is dropped.
 */
export const plainError = (error: string) => {
  const brace = error.search(/\{\s*"/);
  const head = brace < 0 ? error : error.slice(0, brace);
  const title = head.split("\n")[0]?.replace(/[:\s]+$/, "") || error;
  if (brace < 0) return title;
  try {
    const json = JSON.parse(error.slice(brace));
    const message = json?.message ?? json?.error?.message ?? json?.error;
    if (typeof message === "string" && message) return `${title}: ${message}`;
  } catch (e) {
    if (!(e instanceof SyntaxError)) throw e;
  }
  return title;
};

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

/** The card for a task left To check with no check item: why it is there, in plain words. */
function unexplained(t: FoldedTask, check: TaskView["check"], image: Asset | undefined): NeedItem {
  const base = { id: `${t.id}/to-check`, taskId: t.id, image, accepted: false, acceptable: false };
  if (t.rejected || check?.verdict === "needs-review")
    return {
      ...base,
      title: "Sent back by the second AI",
      text: check?.summary ?? "The second AI check sent the result back.",
      found: check?.text,
    };
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
  /** Its worker, and its check, is running now: open while the run is `running`. */
  now: { working: boolean; checking: boolean },
  halt: Halt | undefined,
  /** A thread of its current attempt ended failed, and the run failed. */
  failedOn: boolean,
): TaskState {
  const status = t?.status;
  if (t?.skipped) return "skipped";
  if (status === "done" || status === "to-check" || status === "failed") return status;
  // A fatal provider error fails the run with no task event: the task is the one it failed on.
  if (failedOn) return "failed";
  const started = status === "in-progress" || status === "under-review";
  if (halt && started) return halt.kind === "ended" ? "stopped" : halt.kind;
  if (now.working) return "running";
  if (status === "under-review" && now.checking) return "checking";
  if (started) return "held";
  return blocked ? "waiting" : "ready";
}

type RunView = {
  /** Without the tool calls still being written: `withLiveCalls` adds those per frame. */
  threads: Thread[];
  /** One per plan task, in plan order; empty until the run has a plan. */
  tasks: TaskView[];
  /** `progress` of the latest revision: tasks done of all, and the open check items. */
  progress: { done: number; total: number; toCheck: number };
  spend: RunSpend;
};

/** The fold's title for a To check flag set by a `task` event; the task's name says as much. */
const GENERIC_CHECK = "Marked to check";

/** Everything the run page shows about the run, from its durable events and state. */
export function runView(
  events: RunEvent[],
  state: RunState,
  providerCalls: ProviderCalls | undefined,
  halt: Halt | undefined,
): RunView {
  const logged = threadsOf(events);
  // Open threads run only while the run does: an ended or paused run's open threads were cut off.
  const running = new Set(state.status === "running" ? openThreads(events) : []);
  const threads = halt ? halted(logged.threads, logged.lastAt, halt) : logged.threads;
  const spent = spend(events, providerCalls);
  // No plan until the run's first `revision.started`.
  const latest = reviewState(events, { live: true }).revisions.at(-1);
  if (!latest)
    return {
      threads,
      tasks: [],
      progress: { done: 0, total: 0, toCheck: 0 },
      spend: spent,
    };

  const byId = new Map(latest.tasks.map((t) => [t.id, t]));
  const titles = new Map(latest.plan.tasks.map((p) => [p.id, p.title ?? taskTitle(p.id)]));
  // "tibia-frame was skipped: …", as the fold writes a dependent's reason, with the task's title.
  const skipText = (reason: string) =>
    reason.replace(
      /^([\w-]+) was skipped: /,
      (_, id: string) => `${titles.get(id) ?? id} was skipped: `,
    );
  const loggedById = new Map(logged.threads.map((t) => [t.id, t]));
  // Checkpoints by event id: their researcher sentence, and the thread that wrote them.
  const summaries = new Map<string, string>();
  const writer = new Map<string, string>();
  // Attempts the second AI check sent back, by task: a later attempt is a redo.
  const verdicts = new Map<string, "passed" | "needs-review">();
  const sentBack = new Map<string, Set<string>>();
  const abandoned = abandonedEvents(events);
  for (const e of events)
    if (abandoned.has(e.id)) continue;
    else if (e.type === "checkpoint") {
      writer.set(e.id, e.threadId);
      if (e.payload.summary) summaries.set(e.id, e.payload.summary);
      if (e.payload.verdict && loggedById.get(e.threadId)?.kind === "check")
        verdicts.set(e.payload.attemptId, e.payload.verdict);
    } else if (
      e.type === "task" &&
      e.payload.status === "to-check" &&
      e.payload.by.kind === "rule" &&
      e.payload.by.rule === "check-result" &&
      verdicts.get(e.payload.attemptId) === "needs-review"
    ) {
      const set = sentBack.get(e.payload.taskId) ?? new Set();
      sentBack.set(e.payload.taskId, set.add(e.payload.attemptId));
    }
  const runningOf = (kind: Thread["kind"]) =>
    new Set(
      logged.threads.flatMap((t) =>
        t.kind === kind && running.has(t.id) && t.taskId ? [t.taskId] : [],
      ),
    );
  const working = runningOf("worker");
  const checking = runningOf("check");
  const runFailed = halt?.kind === "ended" && halt.outcome === "failed";
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
    const blocked = p.dependsOn.some((d) => !isSatisfied(byId.get(d)));
    // The logged end, not `halted`'s: a thread cut off by a failed run didn't fail itself.
    const failedThread = runFailed
      ? [t?.threads.worker, t?.threads.check]
          .map((id) => (id ? loggedById.get(id) : undefined))
          .find((th) => th?.status === "failed")
      : undefined;
    const state = stateOf(
      t,
      blocked,
      { working: working.has(p.id), checking: checking.has(p.id) },
      halt,
      failedThread !== undefined,
    );
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
    const check: TaskView["check"] =
      t?.checker && lastVerdict
        ? {
            verdict: t.checker.verdict,
            summary: summaries.get(lastVerdict.id),
            text: t.checker.text,
          }
        : undefined;
    const items: NeedItem[] = (t?.checks ?? []).map((c) => ({
      id: c.id,
      taskId: p.id,
      title: c.title === GENERIC_CHECK ? undefined : c.title,
      text: summaries.get(c.id) ?? (t?.skipped ? skipText(c.detail) : c.detail),
      image: imageOf(t?.milestones.find((m) => m.id === c.id)?.evidenceIds ?? []) ?? image,
      accepted: c.status === "accepted",
      acceptable: true,
    }));
    const reason =
      state === "skipped"
        ? t?.reason && skipText(t.reason)
        : state === "failed"
          ? failedThread
            ? failedThread.error && plainError(failedThread.error)
            : t?.reason
          : undefined;
    return {
      id: p.id,
      title: titles.get(p.id) ?? p.id,
      number: i + 1,
      dependsOn: p.dependsOn,
      state,
      threads: own,
      latest: own.at(-1),
      redone: [...(sentBack.get(p.id) ?? [])].some((a) => a !== t?.attemptId),
      did: lastWorker && summaries.get(lastWorker.id),
      purpose: purpose.get(p.id),
      check,
      rejected: Boolean(t?.rejected),
      reason: reason ?? undefined,
      needs:
        t?.status === "to-check" && items.length === 0 ? [unexplained(t, check, image)] : items,
      image,
      results: t ? resultRows(t, state) : [],
      valued: p.outputs.some((o) => o.kind === "measurement" || o.kind === "score"),
      corrected: Boolean(t && corrections.has(t.resultRevisionId)),
      waitingOn: state === "waiting" ? p.dependsOn.filter((d) => !isSatisfied(byId.get(d))) : [],
      spend: taskSpend.get(p.id),
    };
  });
  return { threads, tasks, progress: progress(latest), spend: spent };
}
