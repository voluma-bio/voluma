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
 * Units: a value counts only in the unit today's `outputs.yaml` declares (`unitOf`). A run reports
 * against the catalog it snapshotted when it started, so a run from before a unit change carries
 * the old unit (210 µm beside 0.21 mm). Such a value stays out of the plot and the far rule and
 * shows as "reported in µm"; converting would guess what the agent meant.
 *
 * A sample's bar: one segment per measurement of the workflow (`measurementsOf`), in catalog
 * order, each read from the newest run's final outputs' status (`outputStatus`, `segmentOf`). A
 * newest run with none listed yet has no bar rather than a made-up one.
 */
import type { OutputStatus } from "@voluma/contracts/output-fold";
import type { StudyDetail, StudyInputDetail } from "@voluma/contracts/study";
import {
  groupNames,
  groupOf,
  inputHref,
  inputStatus,
  needsYouOf,
  placeOfStatus,
} from "@voluma/run-view";
import type { SampleGroup } from "@voluma/ui";
import { type Measurement, unitOf } from "../workflow-measurements";

export type { Measurement };

/**
 * A sample's value for an output in its declared unit; null when it has none (not reported, no
 * number, or reported in another unit: `otherUnit`).
 */
export function inputValue(input: StudyInputDetail, output: Measurement): number | null {
  const reported = input.values[output.id];
  return reported && reported.unit === unitOf(output) ? reported.value : null;
}

/** The unit a sample reported an output's number in when it isn't the declared one, else null. */
export function otherUnit(input: StudyInputDetail, output: Measurement): string | null {
  const reported = input.values[output.id];
  return reported && reported.value !== null && reported.unit !== unitOf(output)
    ? reported.unit
    : null;
}

/** Every sample's value for an output, in its declared unit. */
export const valuesOf = (detail: StudyDetail, output: Measurement) =>
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
export function farFromGroup(detail: StudyDetail, output: Measurement): Map<string, Far> {
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

/** Whether the sample's newest run has listed its final outputs, which its bar is read from. */
export const hasBar = (input: StudyInputDetail) => Object.keys(input.outputStatus).length > 0;

/**
 * One measurement of one sample, as its bar segment and Compare's cell show it:
 * - `check`: it has To check items open;
 * - `making`: the run is still making it;
 * - `reported`: it has a value;
 * - `missing`: the run completed without it;
 * - `stale`: it is out of date in the newest run (a rerun or a correction), so the value shown is
 *   the last completed run's;
 * - `waiting`: there is no value yet, and it is outside the newest run's final outputs;
 * - `stopped`: the run failed or was stopped before making it.
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
 * What the newest run says of the output, and a value it has not reported is being made while the
 * run goes, missing once it completed, else stopped. An output not among the run's final outputs
 * is outside its plan.
 */
export function segmentOf(input: StudyInputDetail, output: Measurement): Segment {
  const state = input.runs[0]?.state;
  switch (input.outputStatus[output.id] as OutputStatus | undefined) {
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
      return input.values[output.id] !== undefined ? "stale" : "waiting";
  }
}

/** Where a sample sits on the study page and in its `?status=` filter. */
export type Place = SampleGroup | "not-started";

/** The places the researcher has to act on: counted in bold, without a mark. */
export const ACT_ON = new Set<Place>(["waiting-on-you", "needs-you"]);

export const PLACES: { place: Place; title: string }[] = [
  { place: "waiting-on-you", title: "Waiting on you" },
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
  return input.runs[0]
    ? placeOfStatus(inputStatus(input).status, input.waiting, example)
    : "not-started";
}

export const placeParam = (value: string | null): Place | null =>
  PLACES.find((p) => p.place === value)?.place ?? null;

/** The samples with items that need a person (`needsYouOf`), most first. */
export const byMostToCheck = (inputs: readonly StudyInputDetail[]) =>
  inputs.filter((s) => needsYouOf(s) > 0).sort((a, b) => needsYouOf(b) - needsYouOf(a));

/** The sample to act on next: one waiting on you first, else the one with most to check. */
export function nextToAct(inputs: readonly StudyInputDetail[], example: boolean) {
  const act = inputs.filter((s) => ACT_ON.has(placeOf(s, example)));
  return act.find((s) => placeOf(s, example) === "waiting-on-you") ?? byMostToCheck(act)[0];
}

/** One line of a study's recent activity, from its runs' own times. */
export type Activity = {
  at: string;
  input: StudyInputDetail;
  kind: "added" | "started" | "completed" | "failed" | "stopped";
  text: string;
};

/** Every run's start and end across the study, newest first. */
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
  ]);
  return times.reduce<string | null>((a, t) => (t && (!a || t > a) ? t : a), null);
}
