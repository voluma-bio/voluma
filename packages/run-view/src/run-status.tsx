/**
 * The status words of a run and of a study, from their read models alone (no events), shared by
 * Home, the study page and the scan review so they read the same: Running, N to check, Checked,
 * Failed, Stopped, Waiting (queued),
 * Needs your keys, Not started. A completed run with no open
 * item reads "Checked" (a failed task raises an item), and "Reviewed" once someone marks it
 * reviewed, which is never inferred. Also where a run's row links (the scan review), how a scan
 * is named, and how its cost and time read.
 */
import type { Run } from "@voluma/contracts/run";
import type { StudyRunSummary, StudyScan } from "@voluma/contracts/study";
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

/** A scan as people name it: its subject and knee ("OA6-1, right knee"), the subject alone without one. */
export function scanLabel(scan: Pick<StudyScan, "subject" | "attributes">): string {
  const knee = scan.attributes.knee;
  return typeof knee === "string" && knee
    ? `${scan.subject}, ${knee.toLowerCase()} knee`
    : scan.subject;
}

/** Where a row leads: the scan review, live while the run goes and for review once it ends. */
export const runHref = ({ runId }: Pick<StudyRunSummary, "runId">) =>
  `/scans/${encodeURIComponent(runId)}`;

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
      return { label: "Waiting", status: "waiting" };
    case "running":
      return { label: "Running", status: "running" };
    case "awaiting-keys":
      return { label: "Needs your keys", status: "paused" };
    case "ended":
      // To check means needs you: a card nobody can accept outranks Reviewed too.
      if (state.outcome === "completed")
        return review?.needsYou
          ? { label: `${review.needsYou} to check`, status: "check" }
          : review?.reviewedAt
            ? { label: "Reviewed", status: "done" }
            : { label: "Checked", status: "done" };
      if (state.outcome === "failed") return { label: "Failed", status: "stopped" };
      return { label: "Stopped", status: "stopped" };
  }
}

/**
 * A study's status from each scan's newest run (`newest`, one per scan that has run) and its
 * items that need the researcher (`StudySummary.needsYou`): what most needs them, else how far it
 * got. "Not started" counts only scans with no run. A study of one reads as its run, except that
 * its items outrank a rerun that hasn't failed: while a rerun is live, `needsYou` counts the
 * newest completed run's acceptable checks (`scanNeedsYou`).
 */
export function studyStatus({
  scans,
  newest,
  needsYou,
}: {
  scans: number;
  newest: Pick<StudyRunSummary, "state" | "review">[];
  needsYou: number;
}): RunStatus {
  const only = newest[0];
  if (scans === 1 && only) {
    const failed = only.state.status === "ended" && only.state.outcome === "failed";
    return needsYou > 0 && !failed
      ? { label: `${needsYou} to check`, status: "check" }
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
  if (needsYou > 0) return { label: `${needsYou} to check`, status: "check" };
  if (count("running") > 0) return { label: "Running", status: "running" };
  if (count("awaiting-keys") > 0) return { label: "Needs your keys", status: "paused" };
  if (count("queued") > 0) return { label: "Waiting", status: "waiting" };
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
