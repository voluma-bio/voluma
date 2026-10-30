/**
 * The status words of a run and of a study, from their read models alone (no events), shared by
 * Home, the study page and the run page so they read the same: Running, N to check, Checked,
 * Failed, Stopped, Waiting (queued), AI unavailable (queued, held after an outage),
 * Needs your keys, Not started. A completed run with no open
 * item reads "Checked" (a failed task raises an item), and "Reviewed" once someone marks it
 * reviewed, which is never inferred. Also where a run's row links, and how its cost and time read.
 * The run page's header says "N items to check" instead, because it sits beside a count of tasks.
 */
import type { StudyRunSummary } from "@voluma/contracts/study";
import type { Status } from "@voluma/ui";

/** "1 run", "3 runs"; `many` for an irregular plural. */
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** A date as "12 Mar". */
export const shortDate = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });

/** US dollars: cents, or a tenth of a cent under a dollar so a short run doesn't read $0.00. */
export function formatUsd(usd: number): string {
  return `$${usd.toFixed(usd < 1 ? 3 : 2)}`;
}

/** Whole seconds as `45 s`, `12 min 5 s` or `2 h 3 min`. */
export function formatDuration(seconds: number): string {
  const s = Math.round(seconds);
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min ${s % 60} s`;
  return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`;
}

/** Where a run's row leads: its scan review, which shows a live run as it goes. */
export const runHref = ({ runId }: Pick<StudyRunSummary, "runId">) => `/scans/${runId}`;

/** Where one To check item leads: its scan review, opened on that task and item (`checkId`, as `acceptCheck` takes it). */
export const itemHref = ({
  runId,
  taskId,
  checkId,
}: {
  runId: string;
  taskId: string;
  checkId: string;
}) => `${runHref({ runId })}?${new URLSearchParams({ task: taskId, item: checkId })}`;

export type RunStatus = { label: string; status: Status };

/** A run's status, with "Task N of M" while it runs: what a row says about a live run. */
export function liveStatus(run: Pick<StudyRunSummary, "state" | "review" | "tasks">): RunStatus {
  const tasks = run.state.status === "running" ? run.tasks : null;
  return tasks
    ? {
        label: `Task ${Math.min(tasks.done + 1, tasks.total)} of ${tasks.total}`,
        status: "running",
      }
    : runStatus(run);
}

/** A run's status; a study's newest-run summary carries the same `state` and `review` fields. */
export function runStatus({ state, review }: Pick<StudyRunSummary, "state" | "review">): RunStatus {
  switch (state.status) {
    case "queued":
      return state.waitingForProvider
        ? { label: "AI unavailable", status: "paused" }
        : { label: "Waiting", status: "waiting" };
    case "running":
      return { label: "Running", status: "running" };
    case "awaiting-keys":
      return { label: "Needs your keys", status: "paused" };
    case "ended":
      if (state.outcome === "completed")
        return review?.reviewedAt
          ? { label: "Reviewed", status: "done" }
          : review?.remainingToCheck
            ? { label: `${review.remainingToCheck} to check`, status: "check" }
            : { label: "Checked", status: "done" };
      if (state.outcome === "failed") return { label: "Failed", status: "stopped" };
      return { label: "Stopped", status: "stopped" };
  }
}

/**
 * A study's status from each scan's newest run (`newest`, one per scan that has run) and its
 * open checks (`StudySummary.toCheck`): what most needs the researcher, else how far it got.
 * "Not started" counts only scans with no run. A study of one reads as its run, except that
 * open checks outrank a rerun that hasn't failed: `toCheck` is the newest *completed* run's,
 * which stay acceptable while a rerun is live.
 */
export function studyStatus({
  scans,
  newest,
  toCheck,
}: {
  scans: number;
  newest: Pick<StudyRunSummary, "state" | "review">[];
  toCheck: number;
}): RunStatus {
  const only = newest[0];
  if (scans === 1 && only) {
    const failed = only.state.status === "ended" && only.state.outcome === "failed";
    return toCheck > 0 && !failed
      ? { label: `${toCheck} to check`, status: "check" }
      : runStatus(only);
  }
  // A live run by its status, an ended one by its outcome.
  const count = (
    kind: "queued" | "running" | "awaiting-keys" | "completed" | "failed" | "cancelled",
  ) =>
    newest.filter(({ state }) => (state.status === "ended" ? state.outcome : state.status) === kind)
      .length;
  const failed = count("failed");
  if (failed > 0) return { label: `${failed} failed`, status: "stopped" };
  if (toCheck > 0) return { label: `${toCheck} to check`, status: "check" };
  if (count("running") > 0) return { label: "Running", status: "running" };
  if (count("awaiting-keys") > 0) return { label: "Needs your keys", status: "paused" };
  // Nothing running or needing keys: every live run is queued, and held ones wait for the AI.
  const queued = newest.filter(({ state }) => state.status === "queued");
  if (queued.length > 0)
    return queued.every(({ state }) => state.status === "queued" && state.waitingForProvider)
      ? { label: "AI unavailable", status: "paused" }
      : { label: "Waiting", status: "waiting" };
  // What is left: completed, stopped, or never run.
  const stopped = count("cancelled");
  const notStarted = scans - newest.length;
  if (notStarted === scans) return { label: "Not started", status: "waiting" };
  if (stopped + notStarted === 0)
    return newest.every((r) => r.review?.reviewedAt)
      ? { label: "Reviewed", status: "done" }
      : { label: "Checked", status: "done" };
  const parts = [
    stopped > 0 && `${stopped} stopped`,
    notStarted > 0 && `${notStarted} not started`,
  ];
  return {
    label: parts.filter(Boolean).join(", "),
    status: stopped > 0 ? "stopped" : "waiting",
  };
}
