/**
 * Synthetic event sequences for `fold`: the cases where a mistake would show a
 * wrong result on the run screen or in the review without any error. Every
 * revision must also parse as part of a `ReviewRun`.
 */
import { describe, expect, it } from "vitest";
import type { RunEvent } from "./events";
import { checkResult, type Folded, type FoldedRevision, fold } from "./fold";
import { reviewRunSchema } from "./review";

type Payload<T extends RunEvent["type"]> = Extract<RunEvent, { type: T }>["payload"];

const RUN = "run1";
const SHA = (n: number) => n.toString(16).padStart(64, "0");

/** A log under construction; `seq` and `createdAt` follow append order. */
function log() {
  const events: RunEvent[] = [];
  const add = <T extends RunEvent["type"]>(
    type: T,
    id: string,
    threadId: string,
    payload: Payload<T>,
  ) => {
    const seq = events.length;
    events.push({
      id,
      runId: RUN,
      threadId,
      createdAt: new Date(Date.UTC(2026, 9, 28, 0, 0, seq)).toISOString(),
      seq,
      type,
      payload,
    } as RunEvent);
  };
  const by = { kind: "agent" } as const;
  const rule = (r: "stuck" | "stale" | "check-start" | "check-result") =>
    ({ kind: "rule", rule: r }) as const;
  return {
    events,
    add,
    revision: (id: string, thread: string, p: Payload<"revision.started">) =>
      add("revision.started", id, thread, p),
    thread: (thread: string, kind: "worker" | "check" | "supervisor", attemptId?: string) =>
      add("thread.started", `${thread}:started`, thread, {
        parentThreadId: null,
        kind,
        ...(attemptId && { attemptId }),
      }),
    open: (id: string, thread: string, taskId: string) =>
      add("attempt.opened", id, thread, { taskId }),
    status: (
      id: string,
      thread: string,
      taskId: string,
      attemptId: string,
      status: Payload<"task">["status"],
      who: Payload<"task">["by"] = by,
    ) =>
      add("task", id, thread, { taskId, attemptId, status, reason: `${status} (${id})`, by: who }),
    checkpoint: (
      id: string,
      thread: string,
      taskId: string,
      attemptId: string,
      extra: Partial<Payload<"checkpoint">> = {},
    ) =>
      add("checkpoint", id, thread, {
        taskId,
        attemptId,
        text: `milestone ${id}`,
        by,
        evidence: [],
        ...extra,
      }),
    value: (
      id: string,
      thread: string,
      taskId: string,
      attemptId: string,
      measurementId: string,
      value: number | null,
      extra: Partial<Payload<"value">> = {},
    ) =>
      add("value", id, thread, {
        taskId,
        attemptId,
        measurementId,
        title: measurementId,
        value,
        unit: "mm",
        confidence: null,
        evidence: [],
        structureIds: [],
        annotationIds: [],
        ...extra,
      }),
    rule,
    /** The runtime's `check-result`: the status `checkResult` gives the folded task. */
    result: (thread: string, taskId: string, attemptId: string) => {
      const t = need(fold(events), taskId);
      add("task", `${thread}:result`, thread, {
        taskId,
        attemptId,
        status: checkResult(t),
        reason: "check result",
        by: rule("check-result"),
      });
    },
  };
}

const need = <T extends { id: string }>(x: { tasks: T[] } | T[], id: string): T => {
  const t = (Array.isArray(x) ? x : x.tasks).find((t) => t.id === id);
  if (!t) throw new Error(`no task ${id}`);
  return t;
};
const rev = (f: Folded, n: number): FoldedRevision => {
  const r = f.revisions[n];
  if (!r) throw new Error(`no revision ${n}`);
  return r;
};

/** Every revision, with the parts the API adds, must be a valid `ReviewRun`. */
function expectParses(f: Folded) {
  const run = {
    id: RUN,
    sample: "s",
    workflows: [{ repo: "o/w", commit: "a".repeat(40) }],
    revisions: f.revisions.map((r) => ({
      id: r.id,
      label: r.reason,
      createdAt: r.createdAt,
      volumes: [],
      structures: [],
      annotations: [],
      tasks: r.tasks.map((t) => ({
        ...t,
        title: t.id,
        ask: "",
        dependsOn: [],
        structureIds: [],
        files: [],
        threads: { ...t.threads, chat: null },
      })),
    })),
  };
  expect(reviewRunSchema.safeParse(run).error).toBeUndefined();
}

const W = "worker";
const SUP = "sup";

/** Tasks a and b finished by the worker, in one revision. */
function twoDone() {
  const l = log();
  l.revision("root:revision", "root", { reason: "run" });
  l.open("w:1:open", W, "a");
  l.status("w:1", W, "a", "w:1:open", "in-progress");
  l.value("w:2", W, "a", "w:1:open", "width", 3.4, {
    evidence: [{ root: "outputs", path: "a.png", sha256: SHA(1) }],
  });
  l.status("w:3", W, "a", "w:1:open", "done");
  l.open("w:4:open", W, "b");
  l.value("w:5", W, "b", "w:4:open", "width", 5);
  l.status("w:6", W, "b", "w:4:open", "done");
  return l;
}

describe("fold", () => {
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
    l.revision("root:revision", "root", { reason: "run" });
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
      l.value("w:9", W, "a", "w:8:open", "width", 3.5);
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

  it("a check without a fix stays in the worker's attempt and one revision", () => {
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
    expectParses(f);
  });

  it("a check with a fix: the earlier revision keeps the worker's result, the new one has the fix", () => {
    const l = twoDone();
    l.thread("chk", "check", "w:1:open");
    l.status("chk:start", "chk", "a", "w:1:open", "under-review", l.rule("check-start"));
    l.checkpoint("chk:1", "chk", "a", "w:1:open", { verdict: "passed", text: "Fixed the plane." });
    l.revision("chk:2:revision", "chk", { reason: "fix", taskId: "a" });
    l.status("chk:2:stale:b", "chk", "b", "w:4:open", "stale", l.rule("stale"));
    l.value("chk:2", "chk", "a", "w:1:open", "width", 3.39);
    l.value("chk:3", "chk", "a", "w:1:open", "area", 12, {
      evidence: [{ root: "scratch", path: "r.py", sha256: SHA(2) }],
    });
    l.result("chk", "a", "w:1:open");
    const f = fold(l.events);
    const [r1, r2] = f.revisions;
    expect(f.revisions.map((r) => r.reason)).toEqual(["run", "fix"]);
    const before = need(r1?.tasks ?? [], "a");
    expect(before.status).toBe("under-review"); // its status at that point in the log
    expect(before.measurements.map((m) => m.value)).toEqual([3.4]);
    expect(before.checks).toEqual([]);
    const after = need(r2?.tasks ?? [], "a");
    expect(after.status).toBe("to-check");
    expect(after.measurements.map((m) => [m.id, m.value])).toEqual([
      ["a/width", 3.39],
      ["a/area", 12],
    ]);
    expect(after.evidence.map((e) => e.sha256)).toEqual([SHA(1), SHA(2)]);
    expect(after.threads).toEqual({ worker: W, check: "chk" });
    expect(after.checker?.verdict).toBe("passed");
    expect(after.checks.map((c) => [c.id, c.title])).toEqual([
      ["chk:2:revision", "Changed by the second agent"],
    ]);
    expect(need(r1?.tasks ?? [], "b").resultRevisionId).toBe("root:revision");
    expect(need(r2?.tasks ?? [], "b")).toMatchObject({
      status: "stale",
      resultRevisionId: "chk:2:revision",
    });
    expect(after.resultRevisionId).toBe("chk:2:revision");
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
    l.revision("root:revision", "root", { reason: "run" });
    l.open("w:1:open", W, "b");
    l.value("w:1", W, "b", "w:1:open", "old", 1);
    l.revision("sup:1:revision", SUP, { reason: "correction", taskId: "a" });
    l.status("sup:1:stale:b", SUP, "b", "w:1:open", "stale", l.rule("stale"));
    l.open("w:3:open", W, "b");
    l.status("w:3", W, "b", "w:3:open", "in-progress");
    l.value("w:4", W, "b", "w:3:open", "new", 3);
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
    l.revision("root:revision", "root", { reason: "run" });
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

  it("B: a second passing check on a fixed attempt stays to-check with the fix item open", () => {
    const l = checked(() => {});
    l.revision("chk:2:revision", "chk", { reason: "fix", taskId: "a" });
    l.value("chk:2", "chk", "a", "w:1:open", "width", 3.39);
    l.result("chk", "a", "w:1:open");
    l.thread("chk2", "check", "w:1:open");
    l.status("chk2:start", "chk2", "a", "w:1:open", "under-review", l.rule("check-start"));
    l.checkpoint("chk2:1", "chk2", "a", "w:1:open", { verdict: "passed", text: "Agreed." });
    l.result("chk2", "a", "w:1:open");
    const f = fold(l.events);
    const a = need(f, "a");
    expect(a.status).toBe("to-check");
    expect(a.checks.map((c) => c.id)).toEqual(["chk:2:revision"]);
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

  it("C: the worker's doubt shows in the revision before a fix and again after it, with the same id", () => {
    const l = checked((l) => l.status("w:7", W, "a", "w:1:open", "to-check"));
    l.revision("chk:2:revision", "chk", { reason: "fix", taskId: "a" });
    l.value("chk:2", "chk", "a", "w:1:open", "width", 3.39);
    l.result("chk", "a", "w:1:open");
    const f = fold(l.events);
    expect(need(rev(f, 0).tasks, "a").checks.map((c) => [c.id, c.title])).toEqual([
      ["w:7", "Marked to check"],
    ]);
    expect(need(rev(f, 1).tasks, "a").checks.map((c) => [c.id, c.title])).toEqual([
      ["w:7", "Marked to check"],
      ["chk:2:revision", "Changed by the second agent"],
    ]);
    expectParses(f);
  });

  it("D: a fix on the checked task leaves an unrelated done task alone", () => {
    const l = checked(() => {});
    l.revision("chk:2:revision", "chk", { reason: "fix", taskId: "a" });
    l.value("chk:2", "chk", "a", "w:1:open", "width", 3.39);
    l.result("chk", "a", "w:1:open");
    const b = need(fold(l.events), "b");
    expect(b).toMatchObject({ status: "done", checks: [], checker: null });
    expect(b.threads.check).toBeNull();
    expectParses(fold(l.events));
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
    l.revision("root:revision", "root", { reason: "run" });
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

  it("measurement ids repeat across tasks; operands resolve; a dangling one is dropped", () => {
    const l = twoDone(); // a/width and b/width
    l.open("w:7:open", W, "c");
    l.value("w:8", W, "c", "w:7:open", "ratio", 0.5, {
      numeratorId: "a/width",
      denominatorId: "b/width",
    });
    l.value("w:9", W, "c", "w:7:open", "self", 1, { numeratorId: "ratio" });
    l.status("w:10", W, "c", "w:7:open", "done");
    // b is redone and no longer reports width.
    l.revision("sup:1:revision", SUP, { reason: "correction", taskId: "b" });
    l.status("sup:1", SUP, "b", "w:4:open", "stale");
    l.open("w:11:open", W, "b");
    l.value("w:12", W, "b", "w:11:open", "depth", 2);
    const f = fold(l.events);
    const [r1, r2] = f.revisions;
    const ratio = (r: typeof r1) => need(r?.tasks ?? [], "c").measurements;
    expect(r1?.tasks.flatMap((t) => t.measurements.map((m) => m.id))).toEqual([
      "a/width",
      "b/width",
      "c/ratio",
      "c/self",
    ]);
    expect(ratio(r1)?.[0]).toMatchObject({ numeratorId: "a/width", denominatorId: "b/width" });
    expect(ratio(r1)?.[1]?.numeratorId).toBe("c/ratio");
    expect(ratio(r2)?.[0]?.numeratorId).toBe("a/width");
    expect(ratio(r2)?.[0]?.denominatorId).toBeUndefined();
    expectParses(f);
  });
});
