/**
 * Task states as both screens show them. A started task under each run status: Waiting while the
 * run waits in line, Paused only while it waits for keys. During a correction: the study read and
 * the scan review must show the corrected task the same way, though `reviewState` holds the
 * correction's revision back for values and checks. Items that need a person: the study read
 * (`shownTasks` over `latestRevision`) counts each task as the scan review does (`openItems` over
 * the live fold) in every state of the run. A mistake here is silent: one screen says Done while
 * the other says Running or To check.
 */
import { describe, expect, it } from "vitest";
import type { RunEvent } from "./events";
import { log, RUN, SUP, W } from "./fold-test-log";
import type { RunStateFacts } from "./review-state";
import {
  latestRevision,
  openCorrectionRevision,
  openItems,
  reviewState,
  shownTasks,
  taskStates,
} from "./review-state";
import { failedThreads, openThreads } from "./threads";

describe("taskStates during a correction", () => {
  it("reads a reopened task's restarted AI as running in both reads", () => {
    const l = log();
    l.run({ tasks: [{ id: "a", dependsOn: [], outputs: [] }] });
    l.thread(W, "worker");
    l.open("w:1:open", W, "a");
    l.status("w:1", W, "a", "w:1:open", "in-progress");
    l.status("w:2", W, "a", "w:1:open", "done");
    l.add("thread.ended", "w:end", W, { status: "completed" });
    // A person's message reopens the run, and the correction restarts the AI on `a`.
    l.add("run.reopened", "p:1:reopened", `${RUN}.person`, { by: "u" });
    l.revision("sup:1:revision", SUP, { reason: "correction", taskId: "a" });
    l.add("thread.started", "w:restarted", W, {
      name: "a.worker",
      parentThreadId: "root",
      workflows: [{ repo: "o/w", commit: "a".repeat(40) }],
      kind: "worker",
    });
    l.open("w:3:open", W, "a");
    l.status("w:3", W, "a", "w:3:open", "in-progress");

    const run = {
      state: { status: "running" } as const,
      open: openThreads(l.events),
      failed: failedThreads(l.events),
    };
    const held = reviewState(l.events).revisions.at(-1);
    const live = reviewState(l.events, { live: true }).revisions.at(-1);
    if (!held || !live) throw new Error("no revision");
    // The held revision still says done: reading states from it is the trap.
    expect([...taskStates(held, run)]).toEqual([["a", "done"]]);
    // The scan review reads the live fold; the study read, the open correction's revision.
    expect([...taskStates(live, run)]).toEqual([["a", "running"]]);
    expect([...taskStates(openCorrectionRevision(l.events) ?? held, run)]).toEqual([
      ["a", "running"],
    ]);
  });
});

describe("taskStates of a started task under each run status", () => {
  const l = log();
  l.run({ tasks: [{ id: "a", dependsOn: [], outputs: [] }] });
  l.thread(W, "worker");
  l.open("w:1:open", W, "a");
  l.status("w:1", W, "a", "w:1:open", "in-progress");
  const revision = reviewState(l.events).revisions.at(-1);

  it.each<[RunStateFacts, string]>([
    [{ status: "running" }, "running"],
    // It lost its runner and waits in line for another.
    [{ status: "queued" }, "waiting"],
    [{ status: "awaiting-keys" }, "paused"],
    [{ status: "ended", outcome: "cancelled" }, "stopped"],
  ])("%o reads %s", (state, expected) => {
    if (!revision) throw new Error("no revision");
    const run = { state, open: openThreads(l.events), failed: failedThreads(l.events) };
    expect(taskStates(revision, run).get("a")).toBe(expected);
  });
});

describe("items that need a person, in the study read and the scan review", () => {
  type Log = ReturnType<typeof log>;
  /** Task `a` worked on by its AI; `then` writes the rest. */
  const taskA = (then: (l: Log) => void) => {
    const l = log();
    l.run({ tasks: [{ id: "a", dependsOn: [], outputs: [] }] });
    l.thread(W, "worker", "w:1:open");
    l.open("w:1:open", W, "a");
    l.status("w:1", W, "a", "w:1:open", "in-progress");
    then(l);
    return l.events;
  };
  const accept = (l: Log, checkId: string) =>
    l.add("check.accepted", `r:${checkId}`, `${RUN}.reviewer`, {
      by: "u",
      revisionId: "root:revision",
      taskId: "a",
      checkId,
      resultRevisionId: "root:revision",
    } as never);
  /** Flagged with an item, then marked To check: two checks. */
  const flagged = (l: Log) => {
    l.checkpoint("w:2", W, "a", "w:1:open", { toCheck: { title: "Plane" } });
    l.status("w:3", W, "a", "w:1:open", "to-check");
  };
  const sentBack = (l: Log) => {
    l.status("w:2", W, "a", "w:1:open", "done");
    l.thread("chk", "check", "w:1:open");
    l.status("chk:start", "chk", "a", "w:1:open", "under-review", l.rule("check-start"));
    l.checkpoint("chk:1", "chk", "a", "w:1:open", { verdict: "needs-review", text: "Wrong." });
    l.result("chk", "a", "w:1:open");
  };
  /** A's checks all accepted, then a person's message reopens the run on `a`. */
  const corrected = (l: Log) => {
    flagged(l);
    accept(l, "w:2");
    accept(l, "w:3");
    l.add("run.reopened", "p:1:reopened", `${RUN}.person`, { by: "u" });
    l.revision("sup:1:revision", SUP, { reason: "correction", taskId: "a" });
    l.open("w:4:open", W, "a");
    l.status("w:4", W, "a", "w:4:open", "in-progress");
  };
  const running = { status: "running" } as const;
  const ended = (outcome: "completed" | "failed" | "cancelled") =>
    ({ status: "ended", outcome }) as const;

  it.each<[string, RunEvent[], RunStateFacts, string, number]>([
    ["to check", taskA(flagged), ended("completed"), "to-check", 2],
    [
      "to check, every check accepted",
      taskA((l) => {
        flagged(l);
        accept(l, "w:2");
        accept(l, "w:3");
      }),
      ended("completed"),
      "to-check",
      0,
    ],
    ["sent back by the second AI", taskA(sentBack), ended("completed"), "to-check", 1],
    ["sent back, on a live run", taskA(sentBack), running, "to-check", 1],
    ["to check, on a stopped run", taskA(flagged), ended("cancelled"), "to-check", 2],
    ["during a correction of an accepted task", taskA(corrected), running, "running", 0],
  ])("%s", (_, events, state, taskState, needsYou) => {
    const run = { state, open: openThreads(events), failed: failedThreads(events) };
    // The study read, as `pg-studies.ts` folds the newest run (`foldRun`).
    const study = shownTasks({
      ...run,
      revision: latestRevision({
        results: reviewState(events),
        correcting: openCorrectionRevision(events),
      }),
    });
    // The scan review: the live fold (`runView`).
    const live = reviewState(events, { live: true }).revisions.at(-1);
    const task = live?.tasks.find((t) => t.id === "a");
    if (!live || !task) throw new Error("no task");
    expect([study.taskState.a, study.needsYou.a ?? 0]).toEqual([taskState, needsYou]);
    expect([taskStates(live, run).get("a"), openItems(task)]).toEqual([taskState, needsYou]);
  });
});
