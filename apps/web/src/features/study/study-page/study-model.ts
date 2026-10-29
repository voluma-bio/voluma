/**
 * What the study page derives from one `StudyDetail`: each scan's status, the tab counts, the
 * headline series by group, the far-from-group flag and the To check kinds. Pure functions, so
 * every tab reads the same numbers.
 *
 * Far from its group (plain statistics, no AI): a scan's value is far when it lies outside the
 * range of its group's other values by more than twice that range, or by more than 10% of their
 * median when they agree closely. It needs at least two other values in the group, so a group of
 * two never flags. With n = 3-8 per group a standard deviation is unstable; the range reads in
 * one sentence ("the other DMM scans measure 2.47-2.51 mm").
 *
 * To check kinds: items group by task and check title, in workflow task order, then title.
 */
import type { StudyDetail, StudyScanDetail, ToCheckItem } from "@voluma/contracts/study";
import type { StatusTone } from "@voluma/ui";
import type { BundledWorkflow } from "@voluma/workflow/bundled";

export type ScanStatus = { label: string; tone: StatusTone };

/** The scan's newest run, which its status shows; values may come from an older completed one. */
export function scanStatus({ runs, toCheck }: StudyScanDetail): ScanStatus {
  const run = runs[0];
  if (!run) return { label: "Not started", tone: "neutral" };
  const { state, review } = run;
  switch (state.status) {
    case "queued":
      return { label: "Waiting", tone: "neutral" };
    case "running":
      return { label: "Running", tone: "info" };
    case "awaiting-keys":
      return { label: "Needs your keys", tone: "check" };
    case "ended":
      if (state.outcome === "failed") return { label: "Failed", tone: "destructive" };
      if (state.outcome === "cancelled") return { label: "Stopped", tone: "neutral" };
      if (toCheck.length > 0) return { label: `${toCheck.length} to check`, tone: "check" };
      return { label: review?.reviewedAt ? "Checked" : "Done", tone: "primary" };
  }
}

/** A run the API or the runner is still moving: the page refetches while one is in view. */
export const isLive = (scan: StudyScanDetail) =>
  scan.runs[0] !== undefined && scan.runs[0].state.status !== "ended";

export type StudyCounts = {
  scans: number;
  /** Scans with a completed result. */
  done: number;
  running: number;
  waiting: number;
  notStarted: number;
  toCheck: number;
};

export function studyCounts(detail: StudyDetail): StudyCounts {
  const status = (s: StudyScanDetail) => s.runs[0]?.state.status;
  return {
    scans: detail.scans.length,
    done: detail.scans.filter((s) => s.resultRunId !== null).length,
    running: detail.scans.filter((s) => status(s) === "running").length,
    waiting: detail.scans.filter((s) => status(s) === "queued" || status(s) === "awaiting-keys")
      .length,
    notStarted: detail.scans.filter((s) => s.runs.length === 0).length,
    toCheck: detail.scans.reduce((n, s) => n + s.toCheck.length, 0),
  };
}

/**
 * What every run of the study has spent so far: the gateway's settled calls when it recorded any
 * (runs before the gateway have none), else the sum the runner's heartbeats reported.
 */
export const studySpend = (detail: StudyDetail) =>
  detail.scans
    .flatMap((s) => s.runs)
    .reduce(
      (usd, run) =>
        usd +
        (run.providerCalls?.calls ? run.providerCalls.costUsd : (run.usage?.modelCostUsd ?? 0)),
      0,
    );

/** The row a scan sits on: its group, or one shared row when no scan of the study has one. */
export const NO_GROUP = "No group";
export const groupOf = (scan: StudyScanDetail, grouped: boolean) =>
  scan.scan.group ?? (grouped ? NO_GROUP : "All scans");

/** Groups in the order their first scan appears in the study. */
export function groupNames(detail: StudyDetail): string[] {
  const grouped = detail.scans.some((s) => s.scan.group !== null);
  return [...new Set(detail.scans.map((s) => groupOf(s, grouped)))];
}

/** A scan's reported value for an output; null when it has none (not reported, or no number). */
export const scanValue = (scan: StudyScanDetail, outputId: string): number | null =>
  scan.values[outputId]?.value ?? null;

/** Every valued scan's value for an output. */
export const valuesOf = (detail: StudyDetail, outputId: string) =>
  detail.scans.flatMap((s) => scanValue(s, outputId) ?? []);

export type Far = {
  /** The other values of the group, low and high. */
  others: [number, number];
};

/** Each scan's far-from-group verdict for one output, keyed by input id; see the header for the rule. */
export function farFromGroup(detail: StudyDetail, outputId: string): Map<string, Far> {
  const grouped = detail.scans.some((s) => s.scan.group !== null);
  const far = new Map<string, Far>();
  for (const group of groupNames(detail)) {
    const valued = detail.scans.flatMap((s) => {
      const v = scanValue(s, outputId);
      return groupOf(s, grouped) === group && v !== null ? [{ id: s.scan.inputId, v }] : [];
    });
    for (const { id, v } of valued) {
      const others = valued.filter((o) => o.id !== id).map((o) => o.v);
      if (others.length < 2) continue;
      const lo = Math.min(...others);
      const hi = Math.max(...others);
      const allowed = Math.max(2 * (hi - lo), 0.1 * Math.abs(median(others)));
      if (v < lo - allowed || v > hi + allowed) far.set(id, { others: [lo, hi] });
    }
  }
  return far;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

/** Decimals for a measurement's values: about three significant figures at their largest. */
export function digitsFor(values: number[]): number {
  const top = Math.max(0, ...values.map(Math.abs));
  return top >= 100 ? 0 : top >= 10 ? 1 : top >= 1 ? 2 : 3;
}

export type CheckKind = {
  key: string;
  taskId: string;
  taskTitle: string;
  title: string;
  /** In study order. */
  items: { scan: StudyScanDetail; item: ToCheckItem }[];
};

export function checkKinds(detail: StudyDetail, workflow: BundledWorkflow): CheckKind[] {
  const kinds = new Map<string, CheckKind>();
  for (const scan of detail.scans) {
    for (const item of scan.toCheck) {
      const key = `${item.taskId}\n${item.title}`;
      const kind = kinds.get(key) ?? {
        key,
        taskId: item.taskId,
        taskTitle: workflow.taskTitle(item.taskId),
        title: item.title,
        items: [],
      };
      kind.items.push({ scan, item });
      kinds.set(key, kind);
    }
  }
  const order = new Map(workflow.tasks.map((t, i) => [t.id, i]));
  const rank = (k: CheckKind) => order.get(k.taskId) ?? workflow.tasks.length;
  return [...kinds.values()].sort((a, b) => rank(a) - rank(b) || a.title.localeCompare(b.title));
}

/** A scan's side and group, as its row's second line. */
export function scanMeta(scan: StudyScanDetail): string[] {
  const side = scan.scan.attributes.side;
  return [typeof side === "string" ? side : null, scan.scan.group].filter(
    (x): x is string => x !== null,
  );
}

/** The run page a scan links to: its newest run's live page. */
export const runPath = (scan: StudyScanDetail) =>
  scan.runs[0] ? `/runs/${scan.runs[0].id}/live` : null;
