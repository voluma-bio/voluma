/**
 * Task states as both screens show them. A started task under each run status: Waiting while the
 * run waits in line, Paused only while it waits for keys. During a correction: the study read and
 * the scan review must show the corrected task the same way, though `reviewState` holds the
 * correction's revision back for values and checks. A mistake here is silent: one screen says
 * Done while the other says Running.
 */
import { describe, expect, it } from "vitest";
import { log, RUN, SUP, W } from "./fold-test-log";
import type { RunStateFacts } from "./review-state";
import { openCorrectionRevision, reviewState, taskStates } from "./review-state";
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
