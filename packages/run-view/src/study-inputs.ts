/**
 * The input-level facts every study page reads from a `StudyDetail`: an input's status, knee and
 * group, and what needs a person on it.
 */
import type { StudyDetail, StudyInputDetail, StudyRunSummary } from "@voluma/contracts/study";
import { INPUT_WORD, type Status } from "@voluma/ui";
import { liveStatus, toCheckText } from "./run-status";

type InputStatus = { label: string; status: Status; open: number };

/** What needs a person on an input: its newest run's open To check items once it completed, as Studies counts it too. */
export const needsYouOf = (input: StudyInputDetail) => input.review?.needsYou ?? 0;

/**
 * An input's status: its newest run's (`liveStatus`, which reads To check from the items that need
 * a person); "Not started" without a run. Its values may come from an older completed run.
 */
export function inputStatus(input: StudyInputDetail): InputStatus {
  const [run] = input.runs;
  if (!run) return { label: "Not started", status: "waiting", open: 0 };
  // The input's `review` is its newest run's.
  const { label, status } = liveStatus({
    ...run,
    review: input.review,
    waiting: input.waiting,
  });
  const open = status === "check" && input.waiting === 0 ? needsYouOf(input) : 0;
  return { label: open > 0 ? toCheckText(open) : label, status, open };
}

/** An input's knee (`attributes.knee`, as `/new`'s intake stores it), or null. */
export function kneeOf(input: StudyInputDetail): string | null {
  const knee = input.member.attributes.knee;
  return typeof knee === "string" && knee ? knee : null;
}

/** The row an input sits on: its group, or one shared row when no input of the study has one. */
export const groupOf = (input: StudyInputDetail, grouped: boolean) =>
  input.member.group ?? (grouped ? "No group" : `All ${INPUT_WORD.many}`);

/** Groups in the order their first input appears in the study. */
export function groupNames(detail: StudyDetail): string[] {
  const grouped = detail.inputs.some((s) => s.member.group !== null);
  return [...new Set(detail.inputs.map((s) => groupOf(s, grouped)))];
}

/** A run the API or the runner is still moving: a page refetches while one is in view. */
export const isLive = (run: Pick<StudyRunSummary, "state"> | undefined) =>
  run !== undefined && run.state.status !== "ended";
