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
 *
 * Task states: a scan's tasks are where its newest run is (`taskStatus`), read with that run's
 * state, so a task working when the run stopped reads Stopped and one working while the run
 * waits for keys reads Paused. A task To check with no open item left reads Done, since its
 * checks were accepted.
 */
import type { TaskStatus } from "@voluma/contracts/ids";
import type { Run } from "@voluma/contracts/run";
import type { StudyDetail, StudyScanDetail, ToCheckItem } from "@voluma/contracts/study";
import type { OutputEntry } from "@voluma/contracts/workflow-files";
import {
  groupNames,
  groupOf,
  kneeOf,
  type NeedItem,
  runHref,
  type ScanGraphTask,
  type StudyGraphTask,
  TASK_STATUS,
  type TaskState,
} from "@voluma/run-view";
import type { Status } from "@voluma/ui";
import type { BundledWorkflow } from "@voluma/workflow/bundled";

export type StudyCounts = {
  scans: number;
  /** Scans with a completed result. */
  done: number;
  running: number;
  /** Queued or needing keys, except runs held until the AI is back (`waitingForAI`). */
  waiting: number;
  waitingForAI: number;
  notStarted: number;
  toCheck: number;
};

export function studyCounts(detail: StudyDetail): StudyCounts {
  const status = (s: StudyScanDetail) => s.runs[0]?.state.status;
  const held = (s: StudyScanDetail) => {
    const state = s.runs[0]?.state;
    return state?.status === "queued" && state.waitingForProvider !== undefined;
  };
  return {
    scans: detail.scans.length,
    done: detail.scans.filter((s) => s.resultRunId !== null).length,
    running: detail.scans.filter((s) => status(s) === "running").length,
    waiting: detail.scans.filter(
      (s) => (status(s) === "queued" && !held(s)) || status(s) === "awaiting-keys",
    ).length,
    waitingForAI: detail.scans.filter(held).length,
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

/** "OA7-2, left knee": the scan's subject and its knee. */
export const scanName = (scan: StudyScanDetail) => {
  const knee = kneeOf(scan);
  return knee ? `${scan.scan.subject}, ${knee.toLowerCase()} knee` : scan.scan.subject;
};

/** Where a scan links: its newest run's review (the scan review shows a live run too). */
export const scanHref = ({ runs: [run] }: StudyScanDetail) =>
  run ? runHref({ runId: run.id }) : null;

/** One task of one scan, from its newest run's task status and that run's state. */
export function taskState(status: TaskStatus | undefined, run: Run | undefined): TaskState {
  switch (status) {
    case undefined:
    case "pending":
    case "stale":
      return "waiting";
    case "done":
      return "done";
    case "to-check":
      return "to-check";
    case "failed":
      return "failed";
    case "in-progress":
    case "under-review": {
      const state = run?.state;
      if (!state || state.status === "ended") return "stopped";
      if (state.status === "awaiting-keys") return "paused";
      if (state.status === "queued") return state.waitingForProvider ? "awaiting-ai" : "paused";
      return status === "in-progress" ? "running" : "checking";
    }
  }
}

/** Open checks of the scan's result for one task, counted only while that result is its newest run. */
function openOn(scan: StudyScanDetail, taskId: string): ToCheckItem[] {
  if (scan.resultRunId === null || scan.runs[0]?.id !== scan.resultRunId) return [];
  return scan.toCheck.filter((item) => item.taskId === taskId);
}

/** A cell of the scan-by-task grid: one task of one scan, and its open checks. */
export function cellOf(scan: StudyScanDetail, taskId: string): { status: Status; open: number } {
  const state = taskState(scan.taskStatus[taskId], scan.runs[0]);
  const open = openOn(scan, taskId).length;
  if (state === "to-check") return { status: open > 0 ? "check" : "done", open };
  return { status: TASK_STATUS[state], open };
}

/** The workflow at study size: each task with its state on every scan, in study order. */
export const studyGraph = (detail: StudyDetail, workflow: BundledWorkflow): StudyGraphTask[] =>
  workflow.tasks.map((t) => ({
    id: t.id,
    title: workflow.taskTitle(t.id),
    dependsOn: t.dependsOn,
    scans: detail.scans.map((s) => cellOf(s, t.id).status),
  }));

/** One scan's tasks at summary size: state, open checks and values, from the study read. */
export function scanGraph(scan: StudyScanDetail, workflow: BundledWorkflow): ScanGraphTask[] {
  return workflow.tasks.map((t) => ({
    id: t.id,
    title: workflow.taskTitle(t.id),
    dependsOn: t.dependsOn,
    state: taskState(scan.taskStatus[t.id], scan.runs[0]),
    needs: openOn(scan, t.id).map(
      (item): NeedItem => ({
        id: item.checkId,
        taskId: item.taskId,
        title: item.title,
        text: item.detail,
        accepted: false,
        acceptable: true,
      }),
    ),
    results: workflow.outputs
      .filter((o) => o.task === t.id && o.kind === "measurement")
      .flatMap((o) => {
        const v = scanValue(scan, o);
        return v === null
          ? []
          : [{ id: o.id, title: o.name, value: formatValue(v), unit: unitOf(o) }];
      }),
  }));
}

/** The task a stopped scan stopped in: the one its run was working on, by its title. */
export function stoppedIn(scan: StudyScanDetail, workflow: BundledWorkflow): string | null {
  const run = scan.runs[0];
  if (run?.state.status !== "ended" || run.state.outcome === "completed") return null;
  const id = Object.entries(scan.taskStatus).find(
    ([, s]) => s === "in-progress" || s === "under-review" || s === "failed",
  )?.[0];
  return id ? workflow.taskTitle(id) : null;
}

/** A measurement as the grid and the summary graph read it: about three significant figures. */
export const formatValue = (v: number) => v.toFixed(digitsFor([v]));

/** The output a task's grid column shows: its headline measurement, else its first. */
export function keyOutput(workflow: BundledWorkflow, taskId: string): OutputEntry | undefined {
  const measures = workflow.outputs.filter((o) => o.task === taskId && o.kind === "measurement");
  return measures.find((o) => workflow.headline.includes(o)) ?? measures[0];
}
