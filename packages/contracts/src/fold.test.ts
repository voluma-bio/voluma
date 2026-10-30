/**
 * Synthetic event sequences for `fold`: attempts, checks and revisions, where a
 * mistake would show a wrong result on the run screen or in the review without
 * any error. Outputs and references are in `fold-outputs.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { eventInputSchema, runEventSchema, runEventsResponseSchema } from "./events";
import { fold, isSatisfied, transitiveDependents } from "./fold";
import { expectParses, log, need, RUN, rev, SHA, SUP, twoDone, W } from "./fold-test-log";
import { reviewState } from "./review-state";

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

  it("a bare attempt is in progress", () => {
    const l = log();
    l.run();
    l.open("w:1:open", W, "a");
    const f = fold(l.events);
    expect(f.tasks.map((t) => [t.id, t.status])).toEqual([["a", "in-progress"]]);
    expectParses(f);
  });

  it("every plan task has a row in plan order: pending without an attempt, with its latest worker", () => {
    const l = log();
    const out = {
      id: "x",
      kind: "measurement",
      unit: "mm",
      on: [] as string[],
      required: true,
    } as const;
    l.run({
      tasks: [
        { id: "a", title: "Task A", instructions: "Do a.", dependsOn: [], outputs: [out] },
        { id: "b", dependsOn: ["a"], outputs: [out] },
        { id: "c", dependsOn: [], outputs: [] },
      ],
    });
    l.thread("w2", "worker");
    l.add("thread.started", "w2:again", "w2", {
      parentThreadId: null,
      workflows: [],
      kind: "worker",
      task: "c",
    });
    l.open("w:1:open", W, "b");
    const f = fold(l.events);
    expect(f.tasks.map((t) => [t.id, t.status, t.attemptId])).toEqual([
      ["a", "pending", null],
      ["b", "in-progress", "w:1:open"],
      ["c", "pending", null],
    ]);
    // Nothing reported and nothing owed yet; the title and ask are the plan's.
    expect(need(f, "a")).toMatchObject({
      title: "Task A",
      ask: "Do a.",
      resultRevisionId: "root:revision",
      missing: [],
      missingRequired: [],
      satisfied: false,
      threads: { worker: null, check: null },
    });
    expect(need(f, "b")).toMatchObject({ title: "b", ask: "", missingRequired: ["x"] });
    expect(need(f, "c").threads.worker).toBe("w2");
    expectParses(f);
  });

  it("sentBack lists the attempts the check sent back; a milestone carries its thread and summary", () => {
    const l = log();
    l.run({ tasks: [{ id: "a", dependsOn: [], outputs: [] }] });
    l.open("w:1:open", W, "a");
    l.checkpoint("w:1", W, "a", "w:1:open", { summary: "Did it." });
    l.thread("c1", "check", "w:1:open");
    l.checkpoint("c1:1", "c1", "a", "w:1:open", { verdict: "needs-review" });
    l.result("c1", "a", "w:1:open");
    const first = need(fold(l.events), "a");
    l.open("w:2:open", W, "a");
    const row = need(fold(l.events), "a");
    expect(row.sentBack).toEqual(["w:1:open"]);
    expect(row.attemptId).toBe("w:2:open");
    expect(first.milestones).toMatchObject([
      { id: "w:1", threadId: W, summary: "Did it." },
      { id: "c1:1", threadId: "c1", verdict: "needs-review" },
    ]);
    expect(first.rejected).toBe(true);
    expect(first.satisfied).toBe(false);
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

  it("a woken check thread keeps its verdict", () => {
    const l = log();
    l.run({
      tasks: [
        { id: "a", dependsOn: [], outputs: [] },
        { id: "c", dependsOn: ["a"], outputs: [] },
      ],
    });
    l.open("w:1:open", W, "c");
    l.status("w:1", W, "c", "w:1:open", "to-check");
    expectParses(fold(l.events));
    l.thread("chk", "check", "w:1:open");
    l.checkpoint("chk:1", "chk", "c", "w:1:open", { verdict: "passed" });
    l.thread("chk", "check", "w:1:open"); // a wake: same thread, started again
    expect(need(fold(l.events), "c").checker?.verdict).toBe("passed");
  });

  it("plan.changed adds tasks and appends done-when and instructions; a colliding id keeps the first", () => {
    const l = log();
    const width = {
      id: "width",
      kind: "measurement",
      unit: "mm",
      on: [] as string[],
      required: true,
    } as const;
    l.run({
      tasks: [
        { id: "a", dependsOn: [], doneWhen: ["one"], instructions: "do a", outputs: [width] },
      ],
    });
    l.add("plan.changed", "m:1:change_plan", "m", {
      reason: "check the placement too",
      add: [{ id: "c", dependsOn: ["a"], outputs: [{ ...width, id: "len" }] }],
      adHoc: [
        { id: "audit", title: "Audit", instructions: "audit it", dependsOn: ["a"] },
        { id: "a", title: "Imposter", instructions: "x", dependsOn: [] },
      ],
      doneWhen: [{ taskId: "a", lines: ["two"] }],
      instructions: [{ taskId: "a", text: "and more" }],
    });
    l.add("plan.changed", "m:2:change_plan", "m", {
      reason: "again",
      add: [{ id: "c", dependsOn: [], outputs: [] }],
    });
    l.open("w:1:open", W, "a");
    const f = fold(l.events);
    const t = (id: string) => f.plan.tasks.find((x) => x.id === id);
    expect(f.plan.tasks.map((x) => x.id)).toEqual(["a", "c", "audit"]);
    expect(t("a")).toMatchObject({ doneWhen: ["one", "two"], instructions: "do a\n\nand more" });
    expect(t("a")?.outputs).toEqual([width]);
    expect(t("c")?.dependsOn).toEqual(["a"]);
    expect(t("audit")).toMatchObject({ title: "Audit", outputs: [] });
    expect(rev(f, 0).plan).toEqual(f.plan);
    expect(need(f, "a").missingRequired).toEqual(["width"]);
    expectParses(f);
    const dup = {
      reason: "r",
      add: [{ id: "x", dependsOn: [], outputs: [] }],
      adHoc: [{ id: "x", title: "X", instructions: "i", dependsOn: [] }],
    };
    expect(runEventSchema.safeParse({ ...l.events[1], payload: dup }).success).toBe(false);
  });

  it("a skip cascades to dependents and folds as to-check with every output missing", () => {
    const l = log();
    const out = (id: string) => [
      { id, kind: "measurement", unit: "mm", on: [] as string[], required: true } as const,
    ];
    l.run({
      tasks: [
        { id: "a", dependsOn: [], outputs: out("x") },
        { id: "b", dependsOn: ["a"], outputs: out("y") },
        { id: "c", dependsOn: ["b"], outputs: out("z") },
        { id: "d", dependsOn: [], outputs: out("w") },
      ],
    });
    // b has an attempt with y reported; a and c have none.
    l.open("w:1:open", W, "b");
    l.measurement("w:2", W, "b", "w:1:open", "y", 1);
    l.add("plan.changed", "m:1:change_plan", "m", {
      reason: "r",
      skip: [{ taskId: "a", reason: "no sample" }],
    });
    const f = fold(l.events);
    expect(f.tasks.map((t) => [t.id, t.status, t.skipped?.reason, t.skipped?.from])).toEqual([
      ["a", "to-check", "no sample", "a"],
      ["b", "to-check", "a was skipped: no sample", "a"],
      ["c", "to-check", "a was skipped: no sample", "a"],
      ["d", "pending", undefined, undefined],
    ]);
    const a = need(f, "a");
    expect(a).toMatchObject({ attemptId: null, missingRequired: [], rejected: false });
    expect(a.missing).toEqual([
      { outputId: "x", kind: "measurement", required: true, reason: "no sample" },
    ]);
    expect(a.checks).toHaveLength(1);
    // The attempt's reported output stays; nothing else is missing.
    expect(need(f, "b").measurements).toHaveLength(1);
    expect(need(f, "b").missing).toEqual([]);
    expectParses(f);
  });

  it("a missing output fills any declaration, with its reason, and counts as reported", () => {
    const l = log();
    l.run({
      tasks: [
        {
          id: "a",
          dependsOn: [],
          outputs: [
            { id: "fig", kind: "file", mediaType: "image/png", required: true },
            { id: "scan", kind: "volume", volumeKind: "labels", required: false },
            { id: "bone", kind: "structure", grid: "scan", required: true },
            { id: "gone", kind: "score", levels: ["0", "1"], on: [], required: true },
          ],
        },
      ],
    });
    l.open("w:1:open", W, "a");
    l.output("w:2", W, "a", "w:1:open", "fig", { kind: "missing", reason: "no figure" });
    l.output("w:3", W, "a", "w:1:open", "bone", { kind: "missing", reason: "not in the scan" });
    const f = fold(l.events);
    const t = need(f, "a");
    expect(t.missingRequired).toEqual(["gone"]);
    expect(t.undeclared).toEqual([]);
    expect(t.missing.map((m) => [m.outputId, m.reason])).toEqual([
      ["fig", "no figure"],
      ["scan", undefined],
      ["gone", undefined],
    ]);
    expect(rev(f, 0).structures).toMatchObject([
      { id: "a/bone", missing: { reason: "not in the scan" } },
    ]);
    expectParses(f);
  });

  it("a result the check rejected is not satisfied; accepting or the fix limit satisfy it", () => {
    const l = log();
    l.run({ tasks: [{ id: "a", dependsOn: [], outputs: [] }] });
    l.open("w:1:open", W, "a");
    l.thread("c1", "check", "w:1:open");
    l.checkpoint("c1:1", "c1", "a", "w:1:open", { verdict: "needs-review" });
    l.result("c1", "a", "w:1:open");
    expect(need(fold(l.events), "a")).toMatchObject({ status: "to-check", rejected: true });
    // Main accepts it.
    l.status("m:1", "m", "a", "w:1:open", "to-check");
    const accepted = need(fold(l.events), "a");
    expect(accepted.rejected).toBe(false);
  });

  it("review skips the revisions of a correction that ended unfinished", () => {
    const person = `${RUN}.person`;
    const l = twoDone();
    // A correction that finished: its revision is the result.
    l.add("run.reopened", "p:1:reopened", person, { by: "u" });
    l.revision("sup:1:revision", SUP, { reason: "correction", taskId: "a" });
    l.add("run.reopened", "p:2:reopened", person, { by: "u" });
    l.revision("sup:2:revision", SUP, { reason: "correction", taskId: "b" });
    l.status("sup:2", SUP, "b", "w:4:open", "stale", l.rule("stale"));
    // While the last one is in progress review keeps the last completed revision.
    expect(reviewState(l.events).revisions.map((r) => r.id)).toEqual([
      "root:revision",
      "sup:1:revision",
    ]);
    expect(reviewState(l.events, { live: true }).revisions.map((r) => r.id)).toEqual([
      "root:revision",
      "sup:1:revision",
      "sup:2:revision",
    ]);
    // The second one failed after its go: it is not the result, the first is.
    l.add("correction.ended", "p:2:ended", person, { status: "failed", error: "boom" });
    const state = reviewState(l.events);
    expect(state.revisions.map((r) => r.id)).toEqual(["root:revision", "sup:1:revision"]);
    expect(state.summary?.revisionId).toBe("sup:1:revision");
  });
});

// a → b → d, a → c → d, e alone.
const graph = [
  { id: "a", dependsOn: [] },
  { id: "b", dependsOn: ["a"] },
  { id: "c", dependsOn: ["a"] },
  { id: "d", dependsOn: ["b", "c"] },
  { id: "e", dependsOn: [] },
];

describe("transitiveDependents", () => {
  it("follows the graph through every path, in plan order", () => {
    expect(transitiveDependents(graph, "a")).toEqual(["b", "c", "d"]);
    expect(transitiveDependents(graph, "c")).toEqual(["d"]);
    expect(transitiveDependents(graph, "d")).toEqual([]);
  });

  it("finds dependents of a task listed after them", () => {
    const reordered = [graph[3], graph[1], graph[0], graph[2]] as typeof graph;
    expect(transitiveDependents(reordered, "a")).toEqual(["d", "b", "c"]);
  });
});

describe("isSatisfied", () => {
  const row = (status: "done" | "to-check" | "failed", over = {}) => ({
    status,
    missingRequired: [] as string[],
    rejected: false,
    ...over,
  });
  it("is true for done, and for to-check with every required output", () => {
    expect(isSatisfied(row("done"))).toBe(true);
    expect(isSatisfied(row("to-check"))).toBe(true);
  });
  it("is false for no attempt, a missing output, a rejected or skipped result, or failure", () => {
    expect(isSatisfied(undefined)).toBe(false);
    expect(isSatisfied(row("to-check", { missingRequired: ["x"] }))).toBe(false);
    expect(isSatisfied(row("to-check", { rejected: true }))).toBe(false);
    expect(isSatisfied(row("done", { skipped: { reason: "r", from: "a" } }))).toBe(false);
    expect(isSatisfied(row("failed"))).toBe(false);
  });
});
