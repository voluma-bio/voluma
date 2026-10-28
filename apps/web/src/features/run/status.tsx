/** Run and task status as the list badges: the caller's statuses mapped to `StatusBadge` tones. */
import type { TaskStatus } from "@voluma/contracts/ids";
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

/** A task's badge: `checking` is a running task whose check thread has started. */
export function taskStatus(
  status: TaskStatus | undefined,
  checking: boolean,
): { label: string; tone: StatusTone } {
  switch (status) {
    case undefined:
    case "pending":
    case "stale":
      return { label: "Queued", tone: "neutral" };
    case "in-progress":
      return checking ? { label: "Checking", tone: "info" } : { label: "Running", tone: "info" };
    case "done":
      return { label: "Done", tone: "primary" };
    case "to-check":
      return { label: "To check", tone: "check" };
    case "failed":
      return { label: "Failed", tone: "destructive" };
    case "under-review":
      return { label: "Under review", tone: "info" };
  }
}
