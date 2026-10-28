/** Run status as the list badge (the caller's statuses mapped to `StatusBadge` tones), and how a run's spend reads. */
import type { Run } from "@voluma/contracts/run";
import { StatusBadge, type StatusTone } from "@voluma/ui";

export function formatTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

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

/** From the first claim to the end, or to now while it runs; null while it waits (queued, or for keys). */
export function runSeconds({ state }: Run, now = Date.now()): number | null {
  if (state.status === "queued" || state.status === "awaiting-keys" || !state.startedAt)
    return null;
  const end = state.status === "ended" ? Date.parse(state.endedAt) : now;
  return (end - Date.parse(state.startedAt)) / 1000;
}

/** Where a row leads: the review (the review lane's `/runs/:runId`) once completed, else the live page. */
export const runHref = (run: Run) =>
  run.state.status === "ended" && run.state.outcome === "completed"
    ? `/runs/${run.id}`
    : `/runs/${run.id}/live`;

export type RunStatus = { label: string; tone: StatusTone; detail?: string };

export function runStatus({ state, toCheck }: Run): RunStatus {
  switch (state.status) {
    case "queued":
      return { label: "Queued", tone: "neutral", detail: `Place ${state.position} in line` };
    case "running":
      return { label: "Running", tone: "info", detail: `Started ${formatTime(state.startedAt)}` };
    case "awaiting-keys":
      return { label: "Needs your keys", tone: "check" };
    case "ended":
      // "Reviewed" needs review state, which the review lane doesn't expose yet. No items is
      // still "Completed": a failed task raises none.
      if (state.outcome === "completed")
        return toCheck
          ? { label: `${toCheck} to check`, tone: "check" }
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
