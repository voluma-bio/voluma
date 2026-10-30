/**
 * Every string the run loop and the tools send an agent, in plain text built from the log: to
 * the main agent the notices of a delivery, its list of agents and the task table (a delivery
 * carries the notices, the live agents and the tasks whose row changed; `main.<n>`'s first
 * message and a liveness nudge carry the full lists and what is still open); to a worker or
 * check thread what a resume tells it. The run loop holds the rules and no prose.
 */

import type { Folded, FoldedTask } from "@voluma/contracts/fold";
import type { ClaimEndReason } from "@voluma/contracts/runner";
import {
  type Notice,
  openAsk,
  type ThreadLog,
  type ThreadRecord,
  type ThreadState,
} from "./thread-log";
import { callKey, effectId, isEffectTool } from "./tools/effects";

/** The reply a worker left when its turn ended without a submit, as the notice quotes it. */
export const REPLY_MAX = 500;

export const fromMain = (text: string) => `From the main agent:\n${text}`;

/** What a worker is told when feedback opens a new attempt of its task. */
export const feedbackText = (taskId: string, text: string) =>
  fromMain(
    `${text}\n\nThis opens a new attempt of ${taskId}: fix it, report its outputs again, then submit_task.`,
  );

const PLAIN_REASON: Record<ClaimEndReason, string> = {
  shutdown: "the runner restarted",
  "self-stop": "the runner lost contact with the server",
  "lease-expired": "the server lost contact with the runner",
  "provider-outage": "the model provider was unavailable",
};

/** What the main agent is told when it calls a tool that waits for the researcher's go. */
export const GO_REFUSAL =
  "The researcher has not said go yet. Answer them with `reply` (you may read files and open images); start no work, message no worker and change no plan until they do.";

/** What `finish_run` is refused with while the researcher's go is not acted on. */
export const goNotActedOn = (taskId: string) =>
  `The researcher said go on ${taskId} and you have not redone it: send its worker feedback with \`message\` (or start a worker if it has none), then wait for the new attempt's check.`;

export const UNANSWERED = "Answer the researcher with `reply` before you finish.";
export const UNDELIVERED = "The researcher wrote again and you have not read it yet; wait for it.";

/** What a cut-off thread is told on resume: the tool it was in, if any, and why, in plain words. */
export function cutOffText(after: ClaimEndReason | undefined, tool: string | undefined): string {
  const when = after ? `when ${PLAIN_REASON[after]}` : "when the run was restarted";
  return tool
    ? `Your last call (\`${tool}\`) was cut off ${when}. It may or may not have finished: check its output, then continue.`
    : `You were cut off ${when}; continue.`;
}

/** Why a check ended the way it did, as the task's reason reads. */
export const CHECK_STOPPED = "The check was stopped before it gave a verdict.";

export function checkReason(t: FoldedTask, status: "done" | "to-check"): string {
  if (status === "done") return "The second agent checked this task and agrees.";
  if (t.checker?.verdict === undefined) return "The check ended without a verdict.";
  if (t.checker.verdict === "needs-review")
    return "The second agent found problems with this task.";
  return t.missingRequired.length > 0
    ? `Required outputs are missing: ${t.missingRequired.join(", ")}.`
    : "The check passed, but items are still open for a person.";
}

export const fixLimitReason = (rounds: number) =>
  `The second agent still found problems after ${rounds} rounds of fixes; this task is left for a person.`;

/** The main agent's answer, as the check thread that asked reads it. */
export function answerText(
  answer: { text: string; files: { root: string; path: string }[] },
  taskId: string,
) {
  const files = answer.files.map((f) => `${f.root}:${f.path}`).join(", ");
  return `The main agent answers: ${answer.text}${files ? `\nFiles for you: ${files} (root "scratch" is /scratch/<path>, "outputs" is /outputs/${taskId}/<path>).` : ""}`;
}

export const verdictNudge = (taskId: string) =>
  `You stopped before giving a verdict. Write a checkpoint on ${taskId} with verdict "passed" if you agree or "needs-review" if you do not or cannot tell, and one plain line of why.`;

const REBUILT = "its record cannot be resumed (the run's prompts, tools or model changed)";
export const unresumableReason = (role: "worker" | "check", taskId: string) =>
  role === "check"
    ? `${REBUILT}; a new check takes over`
    : `${REBUILT}; start a new worker on ${taskId} if it is not done`;

/** The delivery message: the notices, the live agents and the tasks whose row changed. */
export const deliveryText = (
  notices: readonly Notice[],
  agents: string,
  changed: readonly TaskRow[],
) =>
  [
    notices.map(noticeLine).join("\n"),
    `Agents:\n${agents}`,
    changed.length > 0 ? `Tasks that changed:\n${taskTable(changed)}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

/** What the main agent is told when nothing is running and the run is not finished. */
export const livenessNudge = (asking: boolean, state: string) =>
  `Nothing is running and the run is not finished: ${asking ? "answer the checker (nothing else can move until you do), then " : ""}start the next workers, or finish the run.\n\n${state}`;

/** What the researcher reads when the main agent stopped moving and code ended the run. */
export const STUCK_PLAN_REASON =
  "The main agent stopped before every task was done, so the run ended.";
export const STUCK_SKIP_REASON = "The run stopped before this task was done";
export const stuckSummary = (left: readonly TaskRow[]) =>
  left.length
    ? `The run stopped before every task was done: ${left.map((t) => t.id).join(", ")} ${left.length === 1 ? "was" : "were"} skipped.`
    : "The run stopped with every task finished.";

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

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
    case "person":
      return personLine(n);
    case "correction-ended": {
      const what = n.taskId ? `The correction of ${n.taskId}` : "A correction";
      return `- ${what} was ${n.status}${n.error ? ` (${n.error})` : ""} before it finished. Its work was discarded: the tasks, the results and /outputs are back at the revision before it. Nothing it did counts; do not report it as done.`;
    }
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

const POINT_AXES = "[z, y, x]";

function personLine(n: Extract<Notice, { kind: "person" }>): string {
  const lines = [`- The researcher wrote${n.text ? `: "${n.text}"` : "."}`];
  for (const m of n.marks) {
    const where = m.point
      ? `the voxel ${POINT_AXES} = [${m.point.join(", ")}]`
      : `the box ${POINT_AXES} from [${m.box?.min.join(", ")}] to [${m.box?.max.join(", ")}] (inclusive)`;
    lines.push(
      `  Marked ${where} of volume ${m.volumeId}${m.file ? ` (file ${m.file}: a binary array, which \`read_file\` cannot open; you have no tool for it, so work from the marked position, the task's evidence and their view image)` : ""}.`,
    );
  }
  if (n.snapshot) {
    lines.push(`  Their view of it is the image ${n.snapshot}: open it with view_image.`);
  }
  const goOn = n.go ? ` They said go on ${n.taskId}.` : "";
  if (n.closed === "abandoned") {
    lines.push(
      `  That correction was cancelled or failed before you could act on it, so the message is withdrawn.${n.go ? ` Its go on ${n.taskId} is void.` : ""} Do not answer it and start no work for it.`,
    );
  } else if (n.closed === "finished") {
    lines.push(`  That correction finished.${goOn}`);
  } else {
    lines.push(
      n.go
        ? `  They said go on ${n.taskId}: you may now redo it. Send its worker feedback with \`message\` (it opens a new attempt; a worker that was stopped takes \`start_worker\` instead), say in \`reply\` what you are doing, and finish the run once the new attempt is checked and the tasks that build on it are done.`
        : "  Answer them with `reply`. They have not said go, so start no work.",
    );
  }
  return lines.join("\n");
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
  stateOf: (r: ThreadRecord) => ThreadState | undefined,
): string {
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
    const last = r.lastSummary;
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

/**
 * What a main agent that starts inside a correction is told first: the run had finished, so
 * the tasks below are done and these are its results, which answer the researcher's question
 * (their message comes with the state block). Only the values are listed; the text files are
 * read with `read_file` (main has no shell, and `.npy` volumes are binary).
 */
export function finishedRunText(view: Folded): string {
  const lines = view.tasks.flatMap((t) => [
    ...t.measurements.map(
      (m) => `- ${m.id}: ${m.value === null ? "no value" : `${m.value} ${m.unit}`}`,
    ),
    ...t.scores.map((c) => `- ${c.id}: level "${c.level}"`),
  ]);
  return `The run had already finished before the researcher wrote to you. Its tasks are done (see the table below) and their results are the current ones; nothing is being redone unless the researcher said go. Their message is quoted below under "Still open, or not yet told to you": read it and answer it with \`reply\`, from these results when it asks about them. The files are in /outputs/<task id>/ (\`read_file\` opens the text ones; \`.npy\` volumes are binary and it cannot); the values reported:\n${lines.length ? lines.join("\n") : "(none)"}`;
}

/** The full state block: `main.<n>`'s first message and a liveness nudge carry it. */
export function stateBlock(
  d: ThreadLog,
  view: Folded,
  stateOf: (r: ThreadRecord) => ThreadState | undefined,
): string {
  const carried = carriedNotices(d, view);
  return [
    carried.length > 0
      ? `Still open, or not yet told to you:\n${carried.map(noticeLine).join("\n")}`
      : "",
    `Agents:\n${agentsList(d, stateOf)}`,
    `Tasks:\n${taskTable(taskRows(view))}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * What a cut-off call's result says, or undefined when the log shows no effect (the thread
 * then gets the cautious default text). `message` leaves an id only when it opened an attempt;
 * a plain message is found by the user message it put in the target's thread.
 */
export function interruptedResult(
  d: ThreadLog,
  threadId: string,
  tool: string,
  toolCallId: string,
): string | undefined {
  if (!isEffectTool(tool)) return undefined;
  const written = d.written.get(effectId(tool, threadId, toolCallId));
  if (written?.type === "attempt.opened" && tool === "message") {
    return d.threads.get(written.threadId)?.pendingFeedback
      ? "`message` opened the new attempt before the run was cut off, and the worker is being given your text now: do not send it again."
      : "`message` completed before the run was cut off: the worker has it.";
  }
  if (written) {
    const what = tool === "start_worker" ? ` Worker ${written.threadId} was started.` : "";
    return `\`${tool}\` completed before the run was cut off.${what}`;
  }
  const call = d.calls.get(callKey(threadId, toolCallId));
  if (call?.name !== "message") return undefined;
  const sent = d.relayed.some(
    (m) => m.from === threadId && m.to === call.threadId && m.text.endsWith(call.text),
  );
  return sent ? "`message` completed before the run was cut off: the worker has it." : undefined;
}
