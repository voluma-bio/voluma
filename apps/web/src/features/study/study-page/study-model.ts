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
 * Units: a value counts only in the unit today's `outputs.json` declares. `report_output` already
 * refuses a unit that differs from the run's own plan, but that plan is the snapshot taken when
 * the run started: a run from before a unit change in `outputs.json` carries the old unit
 * (210 µm beside 0.21 mm). Such a value stays out of the plot and the far rule and shows as
 * "reported in µm"; converting would guess what the agent meant.
 *
 * To check kinds: items group by task and check title, in workflow task order, then title.
 */
import type { StudyDetail, StudyScanDetail, ToCheckItem } from "@voluma/contracts/study";
import type { OutputEntry } from "@voluma/contracts/workflow-files";
import type { StatusTone } from "@voluma/ui";
import { runHref, runStatus } from "@voluma/ui/run";
import type { BundledWorkflow } from "@voluma/workflow/bundled";

/** Where "Open in 3D" lands: a To check item, or a run's task (a scan far from its group). */
export type CheckStop = ToCheckItem | Pick<ToCheckItem, "runId" | "taskId">;

/** Opens the check panel on `queue` at `start`; the one mount point of every "Open in 3D". */
export type OpenChecks = (queue: CheckStop[], start: number) => void;

/**
 * A scan's status: its newest run's chip (`@voluma/ui/run`), with "N of M tasks" while it runs;
 * "Not started" without a run. Its values may come from an older completed run.
 */
export function scanStatus({ runs }: StudyScanDetail): {
  label: string;
  tone: StatusTone;
  progress?: string;
} {
  const run = runs[0];
  if (!run) return { label: "Not started", tone: "neutral" };
  const { label, tone } = runStatus(run);
  return run.tasks
    ? { label, tone, progress: `${run.tasks.done} of ${run.tasks.total} tasks` }
    : { label, tone };
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
 * What every run of the study has spent so far: the runner's own model calls (heartbeats) plus
 * the sandbox's provider calls through the gateway, two separate amounts, as the run page adds them.
 */
export const studySpend = (detail: StudyDetail) =>
  detail.scans
    .flatMap((s) => s.runs)
    .reduce(
      (usd, run) => usd + (run.usage?.modelCostUsd ?? 0) + (run.providerCalls?.costUsd ?? 0),
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

/** An output's declared unit; "" for one without. */
export const unitOf = (output: OutputEntry) =>
  "unit" in output && typeof output.unit === "string" ? output.unit : "";

/**
 * A scan's value for an output in its declared unit; null when it has none (not reported, no
 * number, or reported in another unit: `otherUnit`).
 */
export function scanValue(scan: StudyScanDetail, output: OutputEntry): number | null {
  const reported = scan.values[output.id];
  return reported && reported.unit === unitOf(output) ? reported.value : null;
}

/** The unit a scan reported an output's number in when it isn't the declared one, else null. */
export function otherUnit(scan: StudyScanDetail, output: OutputEntry): string | null {
  const reported = scan.values[output.id];
  return reported && reported.value !== null && reported.unit !== unitOf(output)
    ? reported.unit
    : null;
}

/** Every scan's value for an output, in its declared unit. */
export const valuesOf = (detail: StudyDetail, output: OutputEntry) =>
  detail.scans.flatMap((s) => scanValue(s, output) ?? []);

export type Far = {
  /** The other values of the group, low and high. */
  others: [number, number];
};

/**
 * Each scan's far-from-group verdict for one output, keyed by input id; see the header for the
 * rule. Each value is compared with the range of the rest, so two similar outliers in one group
 * widen each other's range and neither flags.
 */
export function farFromGroup(detail: StudyDetail, output: OutputEntry): Map<string, Far> {
  const grouped = detail.scans.some((s) => s.scan.group !== null);
  const far = new Map<string, Far>();
  for (const group of groupNames(detail)) {
    const valued = detail.scans.flatMap((s) => {
      const v = scanValue(s, output);
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

/** A group's other values as "2.47–2.51", or one number when they agree. */
export const rangeText = ([lo, hi]: [number, number], digits: number) =>
  lo === hi ? lo.toFixed(digits) : `${lo.toFixed(digits)}–${hi.toFixed(digits)}`;

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

/** A scan's knee (`attributes.knee`, as `/new`'s intake stores it), or null. */
export function kneeOf(scan: StudyScanDetail): string | null {
  const knee = scan.scan.attributes.knee;
  return typeof knee === "string" && knee ? knee : null;
}

/** A scan's knee and group, as its row's second line. */
export const scanMeta = (scan: StudyScanDetail) =>
  [kneeOf(scan), scan.scan.group].filter((x): x is string => x !== null);

/** Where a scan links: its newest run's review once completed, else its live page. */
export const scanHref = (scan: StudyScanDetail) => (scan.runs[0] ? runHref(scan.runs[0]) : null);

/**
 * Why a scan's run failed, in the researcher's words; the raw error stays on the run page. The
 * harness starts a task's failure with its id (`<taskId>: its worker failed on a model provider
 * error…`, `supervisor.ts`), which names the task by its title here.
 */
export function failureText(
  subject: string,
  error: string | undefined,
  workflow: BundledWorkflow,
): { what: string; why?: string } {
  const taskId = error?.match(/^([\w-]+): /)?.[1];
  const what =
    taskId && workflow.tasks.some((t) => t.id === taskId)
      ? `${subject}'s run stopped during ${workflow.taskTitle(taskId)}.`
      : `${subject}'s run stopped before it finished.`;
  return error?.includes("failed on a model provider error")
    ? { what, why: "The AI couldn't reach its provider." }
    : { what };
}
