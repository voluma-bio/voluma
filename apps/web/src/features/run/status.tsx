/** Run status as the list badge: the caller's statuses mapped to `StatusBadge` tones. */
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

/** Where a row leads: the review (the review lane's `/runs/:runId`) once completed, else the live page. */
export const runHref = (run: Run) =>
  run.state.status === "ended" && run.state.outcome === "completed"
    ? `/runs/${run.id}`
    : `/runs/${run.id}/live`;

export type RunStatus = { label: string; tone: StatusTone; detail?: string };

export function runStatus({ state }: Run): RunStatus {
  switch (state.status) {
    case "queued":
      return { label: "Queued", tone: "neutral", detail: `Place ${state.position} in line` };
    case "running":
      return { label: "Running", tone: "info", detail: `Started ${formatTime(state.startedAt)}` };
    case "awaiting-keys":
      return { label: "Needs your keys", tone: "check" };
    case "ended":
      if (state.outcome === "completed") return { label: "Completed", tone: "primary" };
      if (state.outcome === "failed")
        return { label: "Failed", tone: "destructive", detail: state.error };
      return { label: "Stopped", tone: "neutral" };
  }
}

export function RunBadge({ run }: { run: Run }) {
  const { label, tone } = runStatus(run);
  return <StatusBadge tone={tone}>{label}</StatusBadge>;
}
