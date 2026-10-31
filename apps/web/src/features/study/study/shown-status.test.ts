/**
 * The study pages and the scan review show one status for a task in every state of its newest
 * run: each reads its own fold (the study read on the server, the run view in the browser), and a
 * disagreement is silent (Done on the study, To check in the review).
 */
import type { RunEvent } from "@voluma/contracts/events";
import { log, W } from "@voluma/contracts/fold-test-log";
import { openCorrectionRevision, reviewState, shownTasks } from "@voluma/contracts/review-state";
import type { RunState } from "@voluma/contracts/run";
import type { StudyScanDetail } from "@voluma/contracts/study";
import { failedThreads, openThreads } from "@voluma/contracts/threads";
import { haltOf, runView, shownStatus } from "@voluma/run-view";
import type { Status } from "@voluma/ui";
import type { BundledWorkflow } from "@voluma/workflow/bundled";
import { describe, expect, it } from "vitest";
import { cellOf, scanGraph } from "./study-model";

const AT = "2026-10-28T00:00:00.000Z";
const running: RunState = { status: "running", startedAt: AT };
const ended = (outcome: "completed" | "failed" | "cancelled"): RunState => ({
  status: "ended",
  outcome,
  startedAt: AT,
  endedAt: AT,
});

/** One task `a`, its AI working on it; `then` writes the rest. */
function taskA(then: (l: ReturnType<typeof log>) => void) {
  const l = log();
  l.run({ tasks: [{ id: "a", dependsOn: [], outputs: [] }] });
  l.thread(W, "worker", "w:1:open");
  l.open("w:1:open", W, "a");
  l.status("w:1", W, "a", "w:1:open", "in-progress");
  then(l);
  return l.events;
}
const flagged = (l: ReturnType<typeof log>) =>
  l.checkpoint("w:2", W, "a", "w:1:open", { toCheck: { title: "Plane" } });
const accept = (l: ReturnType<typeof log>) => {
  const revisionId = reviewState(l.events).revisions.at(-1)!.id;
  l.add("check.accepted", "r:1", "run1.reviewer", {
    by: "u",
    revisionId,
    taskId: "a",
    checkId: "w:2",
    resultRevisionId: revisionId,
  } as never);
};
const sentBack = (l: ReturnType<typeof log>) => {
  l.status("w:2", W, "a", "w:1:open", "done");
  l.thread("chk", "check", "w:1:open");
  l.status("chk:start", "chk", "a", "w:1:open", "under-review", l.rule("check-start"));
  l.checkpoint("chk:1", "chk", "a", "w:1:open", { verdict: "needs-review", text: "Wrong." });
  l.result("chk", "a", "w:1:open");
};

const CASES: [string, RunEvent[], RunState, Status][] = [
  ["done", taskA((l) => l.status("w:2", W, "a", "w:1:open", "done")), ended("completed"), "done"],
  [
    "done, carrying an open check",
    taskA((l) => {
      flagged(l);
      l.status("w:3", W, "a", "w:1:open", "done");
    }),
    ended("completed"),
    "check",
  ],
  [
    "to check",
    taskA((l) => {
      flagged(l);
      l.status("w:3", W, "a", "w:1:open", "to-check");
    }),
    ended("completed"),
    "check",
  ],
  [
    "to check, every check accepted",
    taskA((l) => {
      flagged(l);
      l.status("w:3", W, "a", "w:1:open", "done");
      accept(l);
    }),
    ended("completed"),
    "done",
  ],
  ["sent back by the second AI", taskA(sentBack), ended("completed"), "check"],
  ["sent back, on a live run", taskA(sentBack), running, "check"],
  [
    "to check, on a live run",
    taskA((l) => l.status("w:2", W, "a", "w:1:open", "to-check")),
    running,
    "check",
  ],
  [
    "to check, on a stopped run",
    taskA((l) => {
      flagged(l);
      l.status("w:3", W, "a", "w:1:open", "to-check");
    }),
    ended("cancelled"),
    "check",
  ],
  [
    "to check, on a failed run",
    taskA((l) => l.status("w:2", W, "a", "w:1:open", "to-check")),
    ended("failed"),
    "check",
  ],
  ["running", taskA(() => {}), running, "running"],
  ["stopped while running", taskA(() => {}), ended("cancelled"), "stopped"],
];

const workflow = {
  tasks: [{ id: "a", dependsOn: [] }],
  outputs: [],
  taskTitle: (id: string) => id,
} as unknown as BundledWorkflow;

/** The study read's scan, as `pg-studies.ts` builds it from the newest run. */
function studyScan(events: RunEvent[], state: RunState): StudyScanDetail {
  const revision = openCorrectionRevision(events) ?? reviewState(events).revisions.at(-1);
  if (!revision) throw new Error("no revision");
  const run = { state, open: openThreads(events), failed: failedThreads(events) };
  return { runs: [{ state }], ...shownTasks(revision, run) } as unknown as StudyScanDetail;
}

/** The scan review: the run view's task, its open items, and the rule. */
function review(events: RunEvent[], state: RunState) {
  const task = runView(events, state, undefined, haltOf(state, true)).tasks[0]!;
  const open = task.needs.filter((n) => !n.accepted).length;
  return { status: shownStatus(task.state, open), open };
}

describe("a task's status on the study pages and in the scan review", () => {
  it.each(CASES)("%s", (_, events, state, status) => {
    const scan = studyScan(events, state);
    const shown = review(events, state);
    expect(shown.status).toBe(status);
    expect(cellOf(scan, "a")).toEqual(shown);
    const [box] = scanGraph(scan, workflow);
    expect(shownStatus(box!.state, box!.open)).toBe(status);
  });
});
