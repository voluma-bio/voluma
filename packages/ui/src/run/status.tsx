/**
 * The status words of a run and of a study, from `Run`s alone (no events), shared by Home, the
 * study page and the run page so they read the same: Running, N to check, Checked, Failed,
 * Waiting (queued), Needs your keys, Not started. A completed run with no open item reads
 * "Checked" (a failed task raises an item), and "Reviewed" once someone marks it reviewed, which
 * is never inferred. Also where a run's row links, and how its cost and time read.
 */
import type { Run } from "@voluma/contracts/run";
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
export const runHref = (run: Run) =>
  run.state.status === "ended" && run.state.outcome === "completed"
    ? `/runs/${run.id}`
    : `/runs/${run.id}/live`;

export type RunStatus = { label: string; tone: StatusTone; detail?: string };

export function runStatus({ state, review }: Run): RunStatus {
  switch (state.status) {
    case "queued":
      return { label: "Waiting", tone: "neutral", detail: `Place ${state.position} in line` };
    case "running":
      return { label: "Running", tone: "info", detail: `Started ${formatTime(state.startedAt)}` };
    case "awaiting-keys":
      return { label: "Needs your keys", tone: "check" };
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
 * open checks (`StudySummary.toCheck`): what most needs the researcher, else how far it got. A
 * study of one reads as its run (`runStatus`).
 */
export function studyStatus({
  scans,
  newest,
  toCheck,
}: {
  scans: number;
  newest: Run[];
  toCheck: number;
}): RunStatus {
  const count = (status: Run["state"]["status"]) =>
    newest.filter((r) => r.state.status === status).length;
  const failed = newest.filter(
    (r) => r.state.status === "ended" && r.state.outcome === "failed",
  ).length;
  if (failed > 0) return { label: `${failed} failed`, tone: "destructive" };
  if (toCheck > 0) return { label: `${toCheck} to check`, tone: "check" };
  if (count("running") > 0) return { label: "Running", tone: "info" };
  if (count("awaiting-keys") > 0) return { label: "Needs your keys", tone: "check" };
  if (count("queued") > 0) return { label: "Waiting", tone: "neutral" };
  const completed = newest.filter(
    (r) => r.state.status === "ended" && r.state.outcome === "completed",
  ).length;
  if (completed === scans) return { label: "Checked", tone: "primary" };
  if (completed > 0) return { label: `${scans - completed} not started`, tone: "neutral" };
  return { label: "Not started", tone: "neutral" };
}
