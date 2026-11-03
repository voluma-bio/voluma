/**
 * The status words of a run and of a study, from their read models alone (no events), shared by
 * Studies, the study page and the input review so they read the same: Running, N to check, Checked,
 * Failed, Stopped, Waiting (queued),
 * Needs your keys, Not started. A completed run with no open
 * item reads "Checked" (a failed task raises an item), and "Reviewed" once someone marks it
 * reviewed, which is never inferred. Also where a run's row links (the input review), how an input
 * is named, and how its cost, time and age ("12 min ago") read.
 */
import type { Run } from "@voluma/contracts/run";
import type { StudyMember, StudyRunSummary } from "@voluma/contracts/study";
import type { Status } from "@voluma/ui";

/** "1 run", "3 runs"; `many` for an irregular plural. */
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * US dollars: cents; a tenth of a cent under a dollar, so a short run doesn't read $0.00; a
 * hundredth of a cent under a cent, so one cached reply doesn't read $0.000. None is $0.
 */
export function formatUsd(usd: number): string {
  if (usd === 0) return "$0";
  return `$${usd.toFixed(usd < 0.01 ? 4 : usd < 1 ? 3 : 2)}`;
}

/**
 * What a run has spent, in US dollars: the runner's own model calls (heartbeats) plus the
 * sandboxes' provider calls through the gateway, two separate amounts. A request of unknown cost
 * adds nothing (`providerCalls.unknownCostCalls`), so this is a floor while there are any.
 */
export const runCost = (run: Pick<Run, "usage" | "providerCalls">) =>
  run.usage.modelCostUsd + run.providerCalls.costUsd;

/** Whole seconds as `45 s`, `12 min 5 s` or `2 h 3 min`. */
export function formatDuration(seconds: number): string {
  const s = Math.round(seconds);
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min ${s % 60} s`;
  return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`;
}

/** An input as people name it: its subject and knee ("OA6-1, right knee"), the subject alone without one. */
export function inputLabel(input: Pick<StudyMember, "subject" | "attributes">): string {
  const knee = input.attributes.knee;
  return typeof knee === "string" && knee
    ? `${input.subject}, ${knee.toLowerCase()} knee`
    : input.subject;
}

/**
 * Where an input opens: its page in a study, on the input's newest run (live while it goes, for
 * review once it ends). `query` carries the page's selection (`task`, `item`, `output`...); a link
 * that means an earlier run adds `run`.
 */
export const inputHref = (studyId: string, inputId: string, query: Record<string, string> = {}) =>
  `/studies/${encodeURIComponent(studyId)}/inputs/${encodeURIComponent(inputId)}${
    Object.keys(query).length > 0 ? `?${new URLSearchParams(query)}` : ""
  }`;

/** Where one To check item leads: its input page, opened on that task and item (`checkId`, as `acceptCheck` takes it). */
export const itemHref = (
  studyId: string,
  inputId: string,
  { taskId, checkId, run }: { taskId: string; checkId: string; run?: string },
) => inputHref(studyId, inputId, { task: taskId, item: checkId, ...(run && { run }) });

export type RunStatus = { label: string; status: Status };

/**
 * A run's status, with "Task N of M" while a task-loop run runs and "Running · N of M in" (final
 * outputs) while an agent-loop run does: what a row says about a live run.
 */
export function liveStatus(
  run: Pick<StudyRunSummary, "state" | "review" | "tasks" | "outputs" | "harness" | "waiting">,
): RunStatus {
  if (run.waiting) return WAITING_ON_YOU;
  const running = run.state.status === "running";
  if (running && run.outputs)
    return {
      label: `Running · ${run.outputs.done} of ${run.outputs.total} in`,
      status: "running",
    };
  const tasks = running ? run.tasks : null;
  return tasks
    ? {
        label: `Task ${Math.min(tasks.done + 1, tasks.total)} of ${tasks.total}`,
        status: "running",
      }
    : runStatus(run);
}

/** What needs a person on one run: open To check items on either loop, never samples ("3 to check"). */
export const toCheckText = (n: number) => `${n} to check`;

/** A run with a held call the researcher can answer (`StudyRunSummary.waiting`): whatever its row says. */
const WAITING_ON_YOU: RunStatus = { label: "Waiting on you", status: "check" };

/** A run's status; a study's newest-run summary carries the same `state` and `review`. */
export function runStatus({ state, review }: Pick<StudyRunSummary, "state" | "review">): RunStatus {
  switch (state.status) {
    case "queued":
      return { label: "Waiting", status: "waiting" };
    case "running":
      return { label: "Running", status: "running" };
    case "awaiting-keys":
      return { label: "Needs your keys", status: "paused" };
    case "ended":
      // To check means needs you: a card nobody can accept outranks Reviewed too.
      if (state.outcome === "completed")
        return review?.needsYou
          ? { label: toCheckText(review.needsYou), status: "check" }
          : review?.reviewedAt
            ? { label: "Reviewed", status: "done" }
            : { label: "Checked", status: "done" };
      if (state.outcome === "failed") return { label: "Failed", status: "stopped" };
      return { label: "Stopped", status: "stopped" };
  }
}

const MINUTE = 60_000;

/** "just now", "4 min ago", "3 h ago", "yesterday", "31 Oct" (with the year when not this one). */
export function whenText(iso: string, now: number): string {
  const then = new Date(iso);
  const ago = now - then.getTime();
  if (ago < MINUTE) return "just now";
  if (ago < 60 * MINUTE) return `${Math.floor(ago / MINUTE)} min ago`;
  const today = new Date(now);
  const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  if (sameDay(then, today)) return `${Math.floor(ago / (60 * MINUTE))} h ago`;
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (sameDay(then, yesterday)) return "yesterday";
  return then.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    ...(then.getFullYear() !== today.getFullYear() && { year: "numeric" }),
  });
}
