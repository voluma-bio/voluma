/**
 * The Samples tree's data (`SampleTree` in @voluma/ui) from the Studies list: each study's
 * samples are its scans' newest runs, grouped by what they ask of the researcher. Needs you is a
 * run with items to check, waiting for keys, or failed or stopped; Running is queued or live;
 * Done is completed with nothing open. An example's samples are Done whatever they hold open:
 * nobody can change an example, so it never needs you. The study page and the scan page both build the tree
 * here, so a sample sits in the same group on both.
 */
import type { StudySummary } from "@voluma/contracts/study";
import type { SampleGroup, Status, TreeStudy } from "@voluma/ui";
import { liveStatus, runHref } from "./run-status";

const GROUP: Record<Status, SampleGroup> = {
  check: "needs-you",
  paused: "needs-you",
  stopped: "needs-you",
  running: "running",
  checking: "running",
  waiting: "running",
  done: "done",
};

export function sampleTree(studies: StudySummary[]): TreeStudy[] {
  return studies.map((study) => ({
    id: study.id,
    name: study.name,
    samples: study.newestRuns.map((run) => {
      const { label, status } = liveStatus(run);
      const group = study.example ? "done" : GROUP[status];
      return {
        id: run.runId,
        name: run.inputName,
        // What it needs, or how far it is; a completed run says nothing more.
        meta: status === "done" ? undefined : label,
        status,
        group,
        href: runHref(run),
      };
    }),
  }));
}
