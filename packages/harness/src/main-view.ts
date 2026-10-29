/**
 * What the main agent is told about the run, in plain text built from the log: the notices of
 * a delivery, the list of its agents, and the task table. A delivery carries the notices, the
 * live agents and the tasks whose row changed; `main.<n>`'s first message and a liveness wake
 * carry the full lists and what is still open.
 */
import type { RunEvent } from "@voluma/contracts/events";
import type { Folded } from "@voluma/contracts/fold";
import {
  type Notice,
  openAsk,
  type ThreadLog,
  type ThreadRecord,
  type ThreadState,
} from "./thread-log";

/** The reply a worker left when its turn ended without a submit, as the notice quotes it. */
export const REPLY_MAX = 500;

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

/** One line (or a few) for a notice. */
export function noticeLine(n: Notice): string {
  const who = n.taskId ? `${n.threadId} (${n.taskId})` : n.threadId;
  switch (n.kind) {
    case "submitted":
      return `- ${who} submitted ${n.taskId}; its check is starting.`;
    case "worker-idle":
      return `- ${who} stopped without submitting${n.reply ? `. Its last words: "${clip(n.reply, REPLY_MAX)}"` : "."}`;
    case "failed":
      return `- ${who} failed: ${clip(n.error, REPLY_MAX)}`;
    case "ask":
      return `- ${who} asks (askId ${n.eventId}): "${n.question}" Reply with \`answer\`.`;
    case "stale":
      return `- ${n.taskId} is stale: ${n.reason}`;
    case "stopped":
      return `- ${who} was stopped: ${n.reason}`;
    case "check-result": {
      const detail = [n.summary, n.text].filter(Boolean).join("\n  ");
      switch (n.rule) {
        case "check-limit":
          return `- The check of ${n.taskId} ran out of time; ${n.taskId} is left to check for the researcher.`;
        case "fix-limit":
          return `- The check of ${n.taskId} found problems again and ${n.taskId} used its fix rounds; it is left to check for the researcher.\n  ${detail}`;
        default:
          if (n.verdict === "passed")
            return `- The check of ${n.taskId} passed.${detail ? `\n  ${detail}` : ""}`;
          if (n.verdict === "needs-review") {
            return `- The check of ${n.taskId} found problems, so ${n.taskId} is rejected: send its worker feedback with \`message\`, or \`accept\` it.\n  ${detail}`;
          }
          return `- The check of ${n.taskId} ended without a verdict; ${n.taskId} is left to check for the researcher.`;
      }
    }
  }
}

/** A plan task as the main agent sees it. The fold has a row only once a task has an attempt or is skipped. */
export interface TaskRow {
  id: string;
  status: string;
  reason: string | null;
  rejected: boolean;
  skipped: string | undefined;
}

/** One row per task of the plan, `pending` for a task the fold has no row for. */
export const taskRows = (view: Folded): TaskRow[] =>
  view.plan.tasks.map(({ id }) => {
    const t = view.tasks.find((x) => x.id === id);
    return {
      id,
      status: t?.status ?? "pending",
      reason: t?.reason ?? null,
      rejected: t?.rejected ?? false,
      skipped: t?.skipped?.reason,
    };
  });

/** The tasks the run cannot end with: not skipped, and neither done nor left to check. */
export const unfinished = (view: Folded): TaskRow[] =>
  taskRows(view).filter((t) => !t.skipped && t.status !== "done" && t.status !== "to-check");

/** The task rows: id, status, and the reason when there is one. */
export function taskTable(rows: readonly TaskRow[]): string {
  return rows
    .map((t) => {
      const flags = [t.skipped && "skipped", t.rejected && "rejected by its check"]
        .filter(Boolean)
        .join(", ");
      return `- ${t.id}: ${t.status}${flags ? ` (${flags})` : ""}${t.reason ? ` — ${clip(t.reason, 160)}` : ""}`;
    })
    .join("\n");
}

const rowKey = (t: TaskRow | undefined) =>
  t && JSON.stringify([t.status, t.reason, t.rejected, t.skipped]);

/** The rows that differ between two folds of the same run. */
export function changedTasks(before: Folded, after: Folded): TaskRow[] {
  const was = taskRows(before);
  return taskRows(after).filter((t) => rowKey(t) !== rowKey(was.find((b) => b.id === t.id)));
}

/** The workers, and the checks that are running or waiting for an answer, with their state. */
export function agentsList(
  d: ThreadLog,
  events: readonly RunEvent[],
  stateOf: (r: ThreadRecord) => ThreadState | undefined,
): string {
  const lastSummary = new Map<string, string>();
  for (const e of events) {
    if (e.type === "checkpoint" && e.payload.summary)
      lastSummary.set(e.threadId, e.payload.summary);
  }
  const lines = [...d.threads.values()].flatMap((r) => {
    if (r.role === "main") return [];
    const state = stateOf(r);
    if (r.role === "check" && state !== "running" && !openAsk(r)) return [];
    const label = openAsk(r)
      ? "waiting for your answer"
      : state === "idle"
        ? r.submitted
          ? "idle, submitted its task"
          : "idle"
        : state;
    const last = lastSummary.get(r.id);
    return [
      `- ${r.id} (${r.role}, ${r.taskId}): ${label}${last ? `. Last checkpoint: ${last}` : ""}`,
    ];
  });
  return lines.length > 0 ? lines.join("\n") : "(none)";
}

/**
 * What a main agent that starts from the record must be told besides the lists: the notices it
 * never got, every question still open (with its askId), and the verdict of each task its
 * check rejected, which only the notice holds.
 */
function carriedNotices(d: ThreadLog, view: Folded): Notice[] {
  const rejected = new Set(view.tasks.flatMap((t) => (t.rejected ? [t.id] : [])));
  const openAsks = new Set(
    [...d.threads.values()].flatMap((r) => {
      const ask = r.role === "check" ? openAsk(r) : undefined;
      return ask ? [ask.id] : [];
    }),
  );
  const latestResult = new Map<string, Notice>();
  for (const n of d.notices) {
    if (n.kind === "check-result" && n.taskId) latestResult.set(n.taskId, n);
  }
  return d.notices.filter((n) =>
    n.kind === "ask"
      ? openAsks.has(n.eventId)
      : d.undelivered.includes(n) ||
        (!!n.taskId && rejected.has(n.taskId) && latestResult.get(n.taskId) === n),
  );
}

/** The full state block: `main.<n>`'s first message and a liveness wake carry it. */
export function stateBlock(
  d: ThreadLog,
  events: readonly RunEvent[],
  view: Folded,
  stateOf: (r: ThreadRecord) => ThreadState | undefined,
): string {
  const carried = carriedNotices(d, view);
  return [
    carried.length > 0
      ? `Still open, or not yet told to you:\n${carried.map(noticeLine).join("\n")}`
      : "",
    `Agents:\n${agentsList(d, events, stateOf)}`,
    `Tasks:\n${taskTable(taskRows(view))}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}
