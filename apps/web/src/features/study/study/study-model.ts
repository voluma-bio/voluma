/**
 * What the study pages derive from one `StudyDetail`: each sample's place (Needs you, Running,
 * Done…), its bar of measurements, the values and the far-from-group flag, and the study's recent
 * activity. Pure functions, so the Studies pane, the study and Compare read the same numbers.
 *
 * Far from its group (plain statistics, no AI): a sample's value is far when it lies outside the
 * range of its group's other values by more than twice that range, or by more than 10% of their
 * median when they agree closely. It needs at least two other values in the group, so a group of
 * two never flags. With n = 3-8 per group a standard deviation is unstable; the range reads in
 * one sentence ("the other DMM samples measure 2.47-2.51 mm").
 *
 * Units: a value counts only in the unit today's `outputs.json` declares. `report_output` already
 * refuses a unit that differs from the run's own plan, but that plan is the snapshot taken when
 * the run started: a run from before a unit change in `outputs.json` carries the old unit
 * (210 µm beside 0.21 mm). Such a value stays out of the plot and the far rule and shows as
 * "reported in µm"; converting would guess what the agent meant.
 *
 * A sample's bar: one segment per measurement of the workflow (`outputs.json`, kind
 * `measurement`), in task order, each read from the sample's own data (`segmentOf`): the task
 * loop's task states, or the agent loop's final outputs' status (`outputStatus`). A newest run
 * with neither (before its plan or its list) has no bar rather than a made-up one.
 */
import type { OutputStatus } from "@voluma/contracts/output-fold";
import type { StudyDetail, StudyInputDetail } from "@voluma/contracts/study";
import type { OutputEntry } from "@voluma/contracts/workflow-files";
import {
  CARD_TITLE,
  cardId,
  groupNames,
  groupOf,
  inputHref,
  inputStatus,
  itemHref,
  needsYouOf,
  placeOfStatus,
  shownStatus,
  type TaskState,
} from "@voluma/run-view";
import type { SampleGroup, Status } from "@voluma/ui";
import type { BundledWorkflow } from "@voluma/workflow/bundled";
import { measurementsOf } from "../workflow-tasks";

/** An output's declared unit; "" for one without. */
export const unitOf = (output: OutputEntry) =>
  "unit" in output && typeof output.unit === "string" ? output.unit : "";

/** The measurements under the task that reports them, in task order: the bar's and table's sections. */
export type Section = { taskId: string; title: string; outputs: OutputEntry[] };

export const sectionsOf = (workflow: BundledWorkflow): Section[] =>
  workflow.tasks
    .map((t) => ({
      taskId: t.id,
      title: workflow.taskTitle(t.id),
      outputs: measurementsOf(workflow).filter((o) => o.task === t.id),
    }))
    .filter((s) => s.outputs.length > 0);

/**
 * A sample's value for an output in its declared unit; null when it has none (not reported, no
 * number, or reported in another unit: `otherUnit`).
 */
export function inputValue(input: StudyInputDetail, output: OutputEntry): number | null {
  const reported = input.values[output.id];
  return reported && reported.unit === unitOf(output) ? reported.value : null;
}

/** The unit a sample reported an output's number in when it isn't the declared one, else null. */
export function otherUnit(input: StudyInputDetail, output: OutputEntry): string | null {
  const reported = input.values[output.id];
  return reported && reported.value !== null && reported.unit !== unitOf(output)
    ? reported.unit
    : null;
}

/** Every sample's value for an output, in its declared unit. */
export const valuesOf = (detail: StudyDetail, output: OutputEntry) =>
  detail.inputs.flatMap((s) => inputValue(s, output) ?? []);

export type Far = {
  /** The other values of the group, low and high. */
  others: [number, number];
};

/**
 * Each sample's far-from-group verdict for one output, keyed by input id; see the header for the
 * rule. Each value is compared with the range of the rest, so two similar outliers in one group
 * widen each other's range and neither flags.
 */
export function farFromGroup(detail: StudyDetail, output: OutputEntry): Map<string, Far> {
  const grouped = detail.inputs.some((s) => s.member.group !== null);
  const far = new Map<string, Far>();
  for (const group of groupNames(detail)) {
    const valued = detail.inputs.flatMap((s) => {
      const v = inputValue(s, output);
      return groupOf(s, grouped) === group && v !== null ? [{ id: s.member.inputId, v }] : [];
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

/** A knee as people say it: "R" → "right", "L" → "left"; anything else as written. */
export const kneeWord = (knee: string) =>
  ({ r: "right", l: "left" })[knee.toLowerCase()] ?? knee.toLowerCase();

/** Where a sample links: its page on its newest run (the page shows a live run too); null before it has a run. */
export const openHref = (studyId: string, input: StudyInputDetail) =>
  input.runs[0] ? inputHref(studyId, input.member.inputId) : null;

/** `?run=` for a value's link when the value comes from a run that is not the newest. */
export const resultRunQuery = (input: StudyInputDetail): { run?: string } =>
  input.resultRunId !== null && input.resultRunId !== input.runs[0]?.id
    ? { run: input.resultRunId }
    : {};

/** One task of one sample: where its newest run is; outside that run's plan, skipped. */
function taskState(input: StudyInputDetail, taskId: string): TaskState {
  const states = input.taskState;
  return states[taskId] ?? (Object.keys(states).length > 0 ? "skipped" : "waiting");
}

/** Whether the sample's newest run has task states or final outputs, which its bar is read from. */
export const hasBar = (input: StudyInputDetail) =>
  Object.keys(input.taskState).length > 0 || Object.keys(input.outputStatus).length > 0;

/**
 * One measurement of one sample, as its bar segment and Compare's cell show it:
 * - `check`: its task is To check with items open (`shownStatus`, the rule every page uses);
 * - `making`: its task is running or under its second check;
 * - `reported`: its task is done;
 * - `missing`: its task is done in the run the values come from, which reported no value for it;
 * - `stale`: its task waits in a newer run (a rerun or a correction), so the value shown is the
 *   last completed run's;
 * - `waiting`: its task waits and there is no value yet (or the task is outside the run's plan);
 * - `stopped`: its task failed or was stopped.
 */
export type Segment = "check" | "making" | "reported" | "missing" | "stale" | "waiting" | "stopped";

export const SEGMENT_WORD: Record<Segment, string> = {
  check: "To check",
  making: "Being made",
  reported: "Reported",
  missing: "Missing",
  stale: "Out of date",
  waiting: "Waiting",
  stopped: "Stopped",
};

/**
 * An agent-loop run's final output as a segment: what the run says of it, and a value it has not
 * reported is being made while the run goes, missing once it completed, else stopped. An output
 * not among the run's final outputs is outside its plan.
 */
function outputSegment(
  input: StudyInputDetail,
  status: OutputStatus | undefined,
  reported: boolean,
) {
  const state = input.runs[0]?.state;
  switch (status) {
    case "to-check":
      return "check";
    case "reported":
      return "reported";
    case "missing":
      return "missing";
    case "out-of-date":
      return "stale";
    case "pending":
      return state?.status !== "ended"
        ? "making"
        : state.outcome === "completed"
          ? "missing"
          : "stopped";
    default:
      return reported ? "stale" : "waiting";
  }
}

export function segmentOf(input: StudyInputDetail, output: OutputEntry): Segment {
  if (Object.keys(input.outputStatus).length > 0)
    return outputSegment(
      input,
      input.outputStatus[output.id],
      input.values[output.id] !== undefined,
    );
  const status = shownStatus(taskState(input, output.task), input.needsYou[output.task] ?? 0);
  const reported = input.values[output.id] !== undefined;
  switch (status) {
    case "check":
      return "check";
    case "running":
    case "checking":
      return "making";
    case "stopped":
      return "stopped";
    case "done":
      return !reported && input.resultRunId === input.runs[0]?.id ? "missing" : "reported";
    default:
      return reported ? "stale" : "waiting";
  }
}

/** Where a sample sits on the study page and in its `?status=` filter. */
export type Place = SampleGroup | "not-started";

export const PLACES: { place: Place; title: string }[] = [
  { place: "needs-you", title: "Needs you" },
  { place: "running", title: "Running" },
  { place: "done", title: "Done" },
  { place: "not-started", title: "Not started" },
];

/**
 * An input's place on the study page and Compare: its group in the Samples tree (`placeOfStatus`,
 * which also keeps an example's inputs out of Needs you), or Not started with no run, which the
 * tree leaves out.
 */
export function placeOf(input: StudyInputDetail, example: boolean): Place {
  return input.runs[0] ? placeOfStatus(inputStatus(input).status, example) : "not-started";
}

export const placeParam = (value: string | null): Place | null =>
  PLACES.find((p) => p.place === value)?.place ?? null;

/**
 * Where an input's run stopped or failed, in the word its status uses: "Failed during Segmentation",
 * from the task it stopped or failed in; "Stopped before it finished" when no task says.
 */
export function stoppedLine(input: StudyInputDetail, workflow: BundledWorkflow): string | null {
  const run = input.runs[0];
  if (run?.state.status !== "ended" || run.state.outcome === "completed") return null;
  const word = run.state.outcome === "failed" ? "Failed" : "Stopped";
  const id = Object.entries(input.taskState).find(
    ([, s]) => s === "stopped" || s === "failed",
  )?.[0];
  return id ? `${word} during ${workflow.taskTitle(id)}` : `${word} before it finished`;
}

/** A To check task's card nobody can accept (`unacceptable`): its task and why. */
const cardsOf = (input: StudyInputDetail) =>
  Object.entries(input.unacceptable).map(([id, why]) => ({ taskId: id, title: CARD_TITLE[why] }));

/** What waits on a sample, in a line: its acceptable checks' titles, then each card as "<task>: <why>". */
export const waitsOn = (input: StudyInputDetail, workflow: BundledWorkflow) =>
  [
    ...new Set([
      ...input.acceptable.map((i) => i.title),
      ...cardsOf(input).map((c) => `${workflow.taskTitle(c.taskId)}: ${c.title}`),
    ]),
  ].join(", ");

/** The samples with items that need a person (`needsYouOf`), most first. */
export const byMostToCheck = (inputs: readonly StudyInputDetail[]) =>
  inputs.filter((s) => needsYouOf(s) > 0).sort((a, b) => needsYouOf(b) - needsYouOf(a));

/** Where a sample opens: its first acceptable item, else its first card, else the input. */
export const reviewHref = (studyId: string, input: StudyInputDetail) => {
  const { inputId } = input.member;
  const newest = input.runs[0]?.id;
  const [item] = input.acceptable;
  if (item)
    // An item belongs to the newest completed run, which a run started since may have passed.
    return itemHref(studyId, inputId, {
      ...item,
      ...(item.runId !== newest && { run: item.runId }),
    });
  const [card] = cardsOf(input);
  return newest && card
    ? itemHref(studyId, inputId, { taskId: card.taskId, checkId: cardId(card.taskId) })
    : openHref(studyId, input);
};

/** The output a folded section shows: its task's headline measurement, else its first. */
export const keyOutput = (workflow: BundledWorkflow, section: Section): OutputEntry =>
  // A section has at least one output (`sectionsOf` drops the rest).
  section.outputs.find((o) => workflow.headline.includes(o)) ?? (section.outputs[0] as OutputEntry);

/** One line of a study's recent activity, from its runs' own times. */
export type Activity = {
  at: string;
  input: StudyInputDetail;
  kind: "added" | "started" | "completed" | "failed" | "stopped" | "reviewed";
  text: string;
};

/** Every run's start, end and review across the study, newest first. */
export function activityOf(detail: StudyDetail): Activity[] {
  const lines: Activity[] = [];
  for (const input of detail.inputs) {
    for (const run of input.runs) {
      const { state } = run;
      const at = (iso: string | null | undefined, kind: Activity["kind"], text: string) => {
        if (iso) lines.push({ at: iso, input, kind, text });
      };
      if (state.status === "queued") at(run.createdAt, "added", "waiting to start");
      if (state.status === "running" || state.status === "ended")
        at(state.startedAt, "started", "run started");
      if (state.status === "ended") {
        const values = run.id === input.resultRunId ? Object.keys(input.values).length : 0;
        if (state.outcome === "completed")
          at(
            state.endedAt,
            "completed",
            values
              ? `run finished, ${values} ${values === 1 ? "value" : "values"}`
              : "run finished",
          );
        else
          at(
            state.endedAt,
            state.outcome === "failed" ? "failed" : "stopped",
            state.outcome === "failed" ? "run failed" : "run stopped",
          );
      }
      at(run.review?.reviewedAt, "reviewed", "marked reviewed");
    }
  }
  return lines.sort((a, b) => b.at.localeCompare(a.at));
}

/** When a sample last changed: the latest time its runs carry. */
export function changedAt(input: StudyInputDetail): string | null {
  const times = input.runs.flatMap((run) => [
    run.createdAt,
    run.state.status === "running" || run.state.status === "ended" ? run.state.startedAt : null,
    run.state.status === "ended" ? run.state.endedAt : null,
    run.review?.reviewedAt ?? null,
  ]);
  return times.reduce<string | null>((a, t) => (t && (!a || t > a) ? t : a), null);
}
