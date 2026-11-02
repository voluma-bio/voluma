/**
 * Where an input sits for the researcher (`placeOfStatus`), and the Samples tree's data
 * (`SampleTree` in @voluma/ui) from the Studies list. Needs you is a run with items to check,
 * waiting for keys, or failed or stopped; Running is queued or live; Done is completed with
 * nothing open. An example's inputs are Done whatever they hold open: nobody can change an
 * example, so it never needs you. The tree, the Studies page and the study pages all group with
 * `placeOfStatus`, so an input sits in the same group everywhere. Only the study pages show the
 * tree today; the input page's tab is to build it here too.
 */
import type { StudySummary } from "@voluma/contracts/study";
import type { SampleGroup, Status, TreeStudy } from "@voluma/ui";
import { inputHref, liveStatus } from "./run-status";

const GROUP: Record<Status, SampleGroup> = {
  check: "needs-you",
  paused: "needs-you",
  stopped: "needs-you",
  running: "running",
  checking: "running",
  waiting: "running",
  done: "done",
};

/** The group of an input whose newest run has this status, in a study that is or isn't an example. */
export const placeOfStatus = (status: Status, example: boolean): SampleGroup =>
  example ? "done" : GROUP[status];

export function sampleTree(studies: StudySummary[]): TreeStudy[] {
  return studies.map((study) => ({
    id: study.id,
    name: study.name,
    samples: study.newestRuns.map((run) => {
      const { label, status } = liveStatus(run);
      return {
        id: run.inputId,
        name: run.inputName,
        // What it needs, or how far it is; a completed run says nothing more.
        meta: status === "done" ? undefined : label,
        status,
        group: placeOfStatus(status, study.example),
        href: inputHref(study.id, run.inputId),
      };
    }),
  }));
}
