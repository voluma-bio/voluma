/**
 * A run's status chip, from the `Run` alone (no events): the caller-independent mapping of
 * `Run.state` and `Run.review` to a `StatusBadge` tone and label, shared by Home, the study
 * page and the run page. A completed run with open items reads "N to check", else
 * "Completed", since a failed task raises no item. Also where a run's row links, and how its
 * cost and time read.
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
      return { label: "Queued", tone: "neutral", detail: `Place ${state.position} in line` };
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
            : { label: "Completed", tone: "primary" };
      if (state.outcome === "failed")
        return { label: "Failed", tone: "destructive", detail: state.error };
      return { label: "Stopped", tone: "neutral" };
  }
}

export function RunBadge({ run }: { run: Run }) {
  const { label, tone } = runStatus(run);
  return <StatusBadge tone={tone}>{label}</StatusBadge>;
}
