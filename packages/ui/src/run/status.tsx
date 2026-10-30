/**
 * The status words of a run and of a study, from their read models alone (no events), shared by
 * Home, the study page and the run page so they read the same: Running, N to check, Checked,
 * Failed, Stopped, Waiting (queued), Needs your keys, Not started. A completed run with no open
 * item reads "Checked" (a failed task raises an item), and "Reviewed" once someone marks it
 * reviewed, which is never inferred. Also where a run's row links, and how its cost and time read.
 */
import type { Run } from "@voluma/contracts/run";
import type { StudyRunSummary } from "@voluma/contracts/study";
import { StatusBadge, type StatusTone } from "../status-badge";

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

export function formatTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Where a row leads: the review (the review lane's `/runs/:runId`) once completed, else the live page. */
export const runHref = ({ runId, state }: Pick<StudyRunSummary, "runId" | "state">) =>
  state.status === "ended" && state.outcome === "completed"
    ? `/runs/${runId}`
    : `/runs/${runId}/live`;

export type RunStatus = { label: string; tone: StatusTone; detail?: string };

/** A run's status; a study's newest-run summary carries the same `state` and `review` fields. */
export function runStatus({ state, review }: Pick<StudyRunSummary, "state" | "review">): RunStatus {
  switch (state.status) {
    case "queued":
      return { label: "Waiting", tone: "neutral", detail: `Place ${state.position} in line` };
    case "running":
      return { label: "Running", tone: "info", detail: `Started ${formatTime(state.startedAt)}` };
    case "awaiting-keys":
      return { label: "Needs your keys", tone: "check" };
    case "awaiting-person":
      return { label: "Waiting on you", tone: "check" };
    case "ended":
      if (state.outcome === "completed")
        return review?.reviewedAt
          ? { label: "Reviewed", tone: "primary" }
          : review?.remainingToCheck
            ? { label: `${review.remainingToCheck} to check`, tone: "check" }
            : { label: "Checked", tone: "primary" };
      if (state.outcome === "failed")
        return { label: "Failed", tone: "destructive", detail: state.error };
      return { label: "Stopped", tone: "neutral" };
  }
}

export function RunBadge({ run }: { run: Run }) {
  const { label, tone } = runStatus(run);
  return <StatusBadge tone={tone}>{label}</StatusBadge>;
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
  if (scans === 1 && newest[0]) {
    const own = runStatus(newest[0]);
    return toCheck > 0 && own.tone !== "destructive"
      ? { label: `${toCheck} to check`, tone: "check" }
      : own;
  }
  // A live run by its status, an ended one by its outcome.
  const count = (
    kind: "queued" | "running" | "awaiting-keys" | "completed" | "failed" | "cancelled",
  ) =>
    newest.filter(({ state }) => (state.status === "ended" ? state.outcome : state.status) === kind)
      .length;
  const failed = count("failed");
  if (failed > 0) return { label: `${failed} failed`, tone: "destructive" };
  if (toCheck > 0) return { label: `${toCheck} to check`, tone: "check" };
  if (count("running") > 0) return { label: "Running", tone: "info" };
  if (count("awaiting-keys") > 0) return { label: "Needs your keys", tone: "check" };
  if (count("queued") > 0) return { label: "Waiting", tone: "neutral" };
  // What is left: completed, stopped, or never run.
  const stopped = count("cancelled");
  const notStarted = scans - newest.length;
  if (notStarted === scans) return { label: "Not started", tone: "neutral" };
  if (stopped + notStarted === 0)
    return newest.every((r) => r.review?.reviewedAt)
      ? { label: "Reviewed", tone: "primary" }
      : { label: "Checked", tone: "primary" };
  const parts = [
    stopped > 0 && `${stopped} stopped`,
    notStarted > 0 && `${notStarted} not started`,
  ];
  return { label: parts.filter(Boolean).join(", "), tone: "neutral" };
}
