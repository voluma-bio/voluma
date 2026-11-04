/**
 * Where an input sits for the researcher (`placeOfStatus`), and the Samples tree's data
 * (`SampleTree` in @voluma/ui) from complete study membership. Needs you is a run with items to check,
 * waiting for keys, or failed or stopped; Running is queued or live; Done is completed with
 * nothing open. Waiting on you is a run holding a call you can answer. An example's inputs are Done whatever they hold open: nobody can change an
 * example, so it never needs you. The tree, the Studies page and the study pages all group with
 * `placeOfStatus`, so an input sits in the same group everywhere. Review shows the current
 * study only; a member without a run goes to its overview row, never a failed review route.
 */
import type { StudyDetail } from "@voluma/contracts/study";
import type { SampleGroup, Status, TreeStudy } from "@voluma/ui";
import { inputHref, inputLabel } from "./run-status";
import { inputStatus } from "./study-inputs";

const GROUP: Record<Status, SampleGroup> = {
  check: "needs-you",
  paused: "needs-you",
  stopped: "needs-you",
  running: "running",
  checking: "running",
  waiting: "running",
  done: "done",
};

/**
 * The group of an input whose newest run has this status and this many calls open for the
 * researcher (`StudyRunSummary.waiting`), in a study that is or isn't an example. Waiting on you
 * comes first: such an input is in no other group, so every count and list agrees.
 */
export const placeOfStatus = (status: Status, waiting: number, example: boolean): SampleGroup =>
  example ? "done" : waiting > 0 ? "waiting-on-you" : GROUP[status];

export function sampleTree(details: StudyDetail[]): TreeStudy[] {
  return details.map(({ study, inputs }) => ({
    id: study.id,
    name: study.name,
    samples: inputs.map((input) => {
      const { label, status } = inputStatus(input);
      const started = input.runs.length > 0;
      return {
        id: input.member.inputId,
        name: inputLabel(input.member),
        statusLabel: label,
        // What it needs, or how far it is; a completed run says nothing more.
        meta: status === "done" ? undefined : label,
        status,
        group: started ? placeOfStatus(status, input.waiting, study.example) : "not-started",
        href: started
          ? inputHref(study.id, input.member.inputId)
          : `/studies/${encodeURIComponent(study.id)}#${encodeURIComponent(input.member.inputId)}`,
      };
    }),
  }));
}
