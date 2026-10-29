/**
 * Synthetic event sequences for `fold`: attempts, checks and revisions, where a
 * mistake would show a wrong result on the run screen or in the review without
 * any error. Outputs and references are in `fold-outputs.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { eventInputSchema, runEventSchema, runEventsResponseSchema } from "./events";
import { fold } from "./fold";
import { expectParses, log, need, rev, SHA, SUP, twoDone, W } from "./fold-test-log";

describe("fold", () => {
  it("event boundaries accept runs and corrections, but reject obsolete checker revisions", () => {
    const event = {
      id: "root:revision",
      runId: "run1",
      threadId: "root",
      seq: 1,
      createdAt: "2026-10-28T00:00:00.000Z",
      type: "revision.started",
    };
    for (const payload of [
      { reason: "run", plan: { tasks: [] } },
      { reason: "correction", taskId: "a" },
    ]) {
      const stored = { ...event, payload };
      expect(eventInputSchema.parse(stored).payload).toEqual(payload);
      expect(runEventSchema.parse(stored).payload).toEqual(payload);
      expect(runEventsResponseSchema.parse({ events: [stored], more: false }).events).toEqual([
        stored,
      ]);
    }
    const obsolete = { ...event, payload: { reason: "fix", taskId: "a" } };
    expect(eventInputSchema.safeParse(obsolete).success).toBe(false);
    expect(runEventSchema.safeParse(obsolete).success).toBe(false);
    expect(runEventsResponseSchema.safeParse({ events: [obsolete], more: false }).success).toBe(
      false,
    );
  });

  it("normal run: one revision holding every task", () => {
    const f = fold(twoDone().events);
    expect(f.revisions).toHaveLength(1);
    expect(f.revisions[0]?.id).toBe("root:revision");
    expect(f.tasks.map((t) => [t.id, t.status, t.resultRevisionId])).toEqual([
      ["a", "done", "root:revision"],
      ["b", "done", "root:revision"],
    ]);
    expect(need(f, "a").threads.worker).toBe(W);
    expect(need(f, "a").evidence.map((e) => e.sha256)).toEqual([SHA(1)]);
    expectParses(f);
  });

  it("a task with no attempt has no row; a bare attempt is in progress", () => {
    const l = log();
    l.run();
    l.open("w:1:open", W, "a");
    const f = fold(l.events);
    expect(f.tasks.map((t) => [t.id, t.status])).toEqual([["a", "in-progress"]]);
    expectParses(f);
  });

  for (const earlier of ["done", "to-check"] as const) {
    it(`rerun after correcting a ${earlier} task keeps the earlier result as a revision`, () => {
      const l = twoDone();
      if (earlier === "to-check") l.status("w:7", W, "a", "w:1:open", "to-check");
      l.revision("sup:1:revision", SUP, { reason: "correction", taskId: "a" });
      l.status("sup:1", SUP, "a", "w:1:open", "stale");
      l.status("sup:1:stale:b", SUP, "b", "w:4:open", "stale", l.rule("stale"));
      l.open("w:8:open", W, "a");
      l.status("w:8", W, "a", "w:8:open", "in-progress");
      l.measurement("w:9", W, "a", "w:8:open", "width", 3.5);
      l.status("w:10", W, "a", "w:8:open", "done");
      const f = fold(l.events);
      expect(f.revisions.map((r) => r.id)).toEqual(["root:revision", "sup:1:revision"]);
      const [r1, r2] = f.revisions;
      expect(r1?.tasks.map((t) => [t.id, t.status])).toEqual([
        ["a", earlier],
        ["b", "done"],
      ]);
      expect(need(r1?.tasks ?? [], "a").measurements[0]?.value).toBe(3.4);
      if (earlier === "to-check")
        expect(need(r1?.tasks ?? [], "a").checks.map((c) => c.title)).toEqual(["Marked to check"]);
      // The corrected task redone; its dependent stale; both changed in revision 2.
      expect(r2?.tasks.map((t) => [t.id, t.status, t.resultRevisionId])).toEqual([
        ["a", "done", "sup:1:revision"],
        ["b", "stale", "sup:1:revision"],
      ]);
      const a2 = need(r2?.tasks ?? [], "a");
      expect(a2.measurements.map((m) => m.value)).toEqual([3.5]);
      expect(a2.evidence).toEqual([]);
      expect(a2.checks).toEqual([]);
      expectParses(f);
    });
  }

  it("a check stays in the worker's attempt and one revision without changing outputs", () => {
    const l = twoDone();
    l.thread("chk", "check", "w:1:open");
    l.status("chk:start", "chk", "a", "w:1:open", "under-review", l.rule("check-start"));
    l.checkpoint("chk:1", "chk", "a", "w:1:open", { verdict: "passed", text: "Reproduced 3.39." });
    l.result("chk", "a", "w:1:open");
    const f = fold(l.events);
    expect(f.revisions).toHaveLength(1);
    const a = need(f, "a");
    expect(a.status).toBe("done");
    expect(a.checker).toEqual({ verdict: "passed", text: "Reproduced 3.39." });
    expect(a.threads).toEqual({ worker: W, check: "chk" });
    expect(a.checks).toEqual([]);
    expect(a.resultRevisionId).toBe("root:revision");
    expect(a.measurements.map((m) => [m.id, m.value])).toEqual([["a/width", 3.4]]);
    expect(a.evidence.map((e) => e.sha256)).toEqual([SHA(1)]);
    expect(need(f, "b")).toMatchObject({ status: "done", checks: [], checker: null });
    expectParses(f);
  });

  it("a verdict from a non-check thread is ignored", () => {
    const l = twoDone();
    l.checkpoint("w:7", W, "a", "w:1:open", { verdict: "passed" });
    const f = fold(l.events);
    expect(need(f, "a").checker).toBeNull();
    expect(need(f, "a").milestones.at(-1)?.verdict).toBeUndefined();
    expectParses(f);
  });

  it("a correction during a check leaves the task stale", () => {
    const l = twoDone();
    l.thread("chk", "check", "w:1:open");
    l.status("chk:start", "chk", "a", "w:1:open", "under-review", l.rule("check-start"));
    l.revision("sup:1:revision", SUP, { reason: "correction", taskId: "a" });
    l.status("sup:1", SUP, "a", "w:1:open", "stale");
    // The runtime stopped the check, so no check-result follows.
    const f = fold(l.events);
    expect(need(f, "a")).toMatchObject({ status: "stale", resultRevisionId: "sup:1:revision" });
    expect(need(rev(f, 0).tasks, "a").status).toBe("under-review");
    expectParses(f);
  });

  it("a stale mark mid-attempt: the redo is a new attempt, the earlier writes stay behind", () => {
    const l = log();
    l.run();
    l.open("w:1:open", W, "b");
    l.measurement("w:1", W, "b", "w:1:open", "old", 1);
    l.revision("sup:1:revision", SUP, { reason: "correction", taskId: "a" });
    l.status("sup:1:stale:b", SUP, "b", "w:1:open", "stale", l.rule("stale"));
    l.open("w:3:open", W, "b");
    l.status("w:3", W, "b", "w:3:open", "in-progress");
    l.measurement("w:4", W, "b", "w:3:open", "new", 3);
    const f = fold(l.events);
    const [r1, r2] = f.revisions;
    expect(need(r1?.tasks ?? [], "b").measurements.map((m) => m.id)).toEqual(["b/old"]);
    expect(need(r1?.tasks ?? [], "b").status).toBe("in-progress");
    expect(need(r2?.tasks ?? [], "b").attemptId).toBe("w:3:open");
    expect(need(r2?.tasks ?? [], "b").measurements.map((m) => m.id)).toEqual(["b/new"]);
    expectParses(f);
  });

  it("the stuck guard marks an unfinished task to check", () => {
    const l = log();
    l.run();
    l.open("w:1:open", W, "a");
    l.status("w:1", W, "a", "w:1:open", "in-progress");
    l.status("w:stuck:a", W, "a", "w:1:open", "to-check", l.rule("stuck"));
    const f = fold(l.events);
    expect(need(f, "a").checks).toEqual([
      { id: "w:stuck:a", title: "Marked to check", detail: "to-check (w:stuck:a)", status: "open" },
    ]);
    expectParses(f);
  });

  it("a toCheck checkpoint and the to-check mark are two items; a later done clears only the mark", () => {
    const l = twoDone();
    l.checkpoint("w:7", W, "a", "w:1:open", { toCheck: { title: "Plane" }, text: "Unsure" });
    l.status("w:8", W, "a", "w:1:open", "to-check");
    expect(need(fold(l.events), "a").checks.map((c) => [c.id, c.title])).toEqual([
      ["w:7", "Plane"],
      ["w:8", "Marked to check"],
    ]);
    l.status("w:9", W, "a", "w:1:open", "done");
    const f = fold(l.events);
    expect(need(f, "a").checks.map((c) => c.id)).toEqual(["w:7"]);
    expectParses(f);
  });

  /** Task a done by the worker, then checked by `chk`: the log up to the verdict. */
  function checked(
    prep: (l: ReturnType<typeof twoDone>) => void,
    verdict: "passed" | "needs-review" = "passed",
  ) {
    const l = twoDone();
    prep(l);
    l.thread("chk", "check", "w:1:open");
    l.status("chk:start", "chk", "a", "w:1:open", "under-review", l.rule("check-start"));
    l.checkpoint("chk:1", "chk", "a", "w:1:open", { verdict, text: "Looked." });
    return l;
  }

  it("A: a passing check leaves the worker's toCheck item open, so the task is to-check", () => {
    const l = checked((l) => {
      l.checkpoint("w:7", W, "a", "w:1:open", { toCheck: { title: "Plane" }, text: "Unsure" });
      l.status("w:8", W, "a", "w:1:open", "to-check");
    });
    l.result("chk", "a", "w:1:open");
    const f = fold(l.events);
    expect(need(f, "a").status).toBe("to-check");
    expect(need(f, "a").checks.map((c) => c.title)).toEqual(["Plane", "Marked to check"]);
    expectParses(f);
  });

  it("A2: a passing check leaves the worker's mark open too; the item keeps its id", () => {
    const l = checked((l) => l.status("w:7", W, "a", "w:1:open", "to-check"));
    l.result("chk", "a", "w:1:open");
    const f = fold(l.events);
    expect(need(f, "a").status).toBe("to-check");
    expect(need(f, "a").checks.map((c) => [c.id, c.title])).toEqual([["w:7", "Marked to check"]]);
    expectParses(f);
  });

  it("a check result never makes an item of its own", () => {
    const l = checked(() => {}, "needs-review");
    l.result("chk", "a", "w:1:open");
    const f = fold(l.events);
    expect(need(f, "a")).toMatchObject({ status: "to-check", checks: [] });
    expectParses(f);
  });

  it("a second passing check leaves an explicit To check item open", () => {
    const l = checked((l) =>
      l.checkpoint("w:7", W, "a", "w:1:open", { toCheck: { title: "Plane" } }),
    );
    l.result("chk", "a", "w:1:open");
    l.thread("chk2", "check", "w:1:open");
    l.status("chk2:start", "chk2", "a", "w:1:open", "under-review", l.rule("check-start"));
    l.checkpoint("chk2:1", "chk2", "a", "w:1:open", { verdict: "passed", text: "Agreed." });
    l.result("chk2", "a", "w:1:open");
    const f = fold(l.events);
    const a = need(f, "a");
    expect(a.status).toBe("to-check");
    expect(a.checks.map((c) => c.id)).toEqual(["w:7"]);
    // The shown verdict and thread are the second check's.
    expect(a.checker).toEqual({ verdict: "passed", text: "Agreed." });
    expect(a.threads.check).toBe("chk2");
    expectParses(f);
  });

  it("L4: a second check without a verdict does not show the first check's verdict", () => {
    const l = checked(() => {});
    l.result("chk", "a", "w:1:open");
    l.thread("chk2", "check", "w:1:open");
    l.status("chk2:start", "chk2", "a", "w:1:open", "under-review", l.rule("check-start"));
    const f = fold(l.events);
    expect(need(f, "a").checker).toBeNull();
    expect(need(f, "a").threads.check).toBe("chk2");
    expectParses(f);
  });

  it("the worker's doubt keeps its id across a correction to an unrelated task", () => {
    const l = checked((l) => l.status("w:7", W, "a", "w:1:open", "to-check"));
    l.result("chk", "a", "w:1:open");
    l.revision("sup:1:revision", SUP, { reason: "correction", taskId: "b" });
    l.status("sup:1", SUP, "b", "w:4:open", "stale");
    l.open("w:8:open", W, "b");
    const f = fold(l.events);
    expect(need(rev(f, 0).tasks, "a").checks.map((c) => [c.id, c.title])).toEqual([
      ["w:7", "Marked to check"],
    ]);
    expect(need(rev(f, 1).tasks, "a").checks.map((c) => [c.id, c.title])).toEqual([
      ["w:7", "Marked to check"],
    ]);
    expect(need(f, "a").resultRevisionId).toBe("root:revision");
    expectParses(f);
  });

  it("a check that passed, then a correction: the old revision keeps the check, the redo starts clean", () => {
    const l = checked(() => {});
    l.result("chk", "a", "w:1:open");
    l.revision("sup:1:revision", SUP, { reason: "correction", taskId: "a" });
    l.status("sup:1", SUP, "a", "w:1:open", "stale");
    l.open("w:8:open", W, "a");
    const f = fold(l.events);
    const before = need(rev(f, 0).tasks, "a");
    expect(before).toMatchObject({ status: "done", threads: { worker: W, check: "chk" } });
    expect(before.checker?.verdict).toBe("passed");
    expect(need(rev(f, 1).tasks, "a")).toMatchObject({
      status: "in-progress",
      attemptId: "w:8:open",
      checker: null,
      checks: [],
      threads: { worker: W, check: null },
    });
    expectParses(f);
  });

  it("a second attempt after failed replaces the row; the failed attempt's mark does not carry", () => {
    const l = log();
    l.run();
    l.open("w:1:open", W, "a");
    l.status("w:1", W, "a", "w:1:open", "to-check");
    l.status("w:2", W, "a", "w:1:open", "failed");
    expect(need(fold(l.events), "a")).toMatchObject({ status: "failed", checks: [] });
    l.open("w:3:open", W, "a");
    const f = fold(l.events);
    expect(f.tasks.map((t) => [t.id, t.attemptId, t.status])).toEqual([
      ["a", "w:3:open", "in-progress"],
    ]);
    expectParses(f);
  });

  it("a dependency without a row is left out; a woken check thread keeps its verdict", () => {
    const l = log();
    l.run({
      tasks: [
        { id: "a", dependsOn: [], outputs: [] },
        { id: "c", dependsOn: ["a"], outputs: [] },
      ],
    });
    l.open("w:1:open", W, "c");
    l.status("w:1", W, "c", "w:1:open", "to-check");
    expect(need(fold(l.events), "c").dependsOn).toEqual([]);
    expectParses(fold(l.events));
    l.thread("chk", "check", "w:1:open");
    l.checkpoint("chk:1", "chk", "c", "w:1:open", { verdict: "passed" });
    l.thread("chk", "check", "w:1:open"); // a wake: same thread, started again
    expect(need(fold(l.events), "c").checker?.verdict).toBe("passed");
  });
});
