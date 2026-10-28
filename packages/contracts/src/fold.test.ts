/**
 * Synthetic event sequences for `fold`: the cases where a mistake would show a
 * wrong result on the run screen or in the review without any error. Every
 * revision must also parse as part of a `ReviewRun`.
 */
import { describe, expect, it } from "vitest";
import type { RunEvent } from "./events";
import { type Folded, fold } from "./fold";
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
  };
}

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
    expect(f.tasks[0]?.threads.worker).toBe(W);
    expect(f.tasks[0]?.evidence.map((e) => e.sha256)).toEqual([SHA(1)]);
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
      expect(r1?.tasks[0]?.measurements[0]?.value).toBe(3.4);
      if (earlier === "to-check")
        expect(r1?.tasks[0]?.checks.map((c) => c.title)).toEqual(["Marked to check"]);
      // The corrected task redone; its dependent stale; both changed in revision 2.
      expect(r2?.tasks.map((t) => [t.id, t.status, t.resultRevisionId])).toEqual([
        ["a", "done", "sup:1:revision"],
        ["b", "stale", "sup:1:revision"],
      ]);
      expect(r2?.tasks[0]?.measurements.map((m) => m.value)).toEqual([3.5]);
      expect(r2?.tasks[0]?.evidence).toEqual([]);
      expect(r2?.tasks[0]?.checks).toEqual([]);
      expectParses(f);
    });
  }

  it("a check without a fix stays in the worker's attempt and one revision", () => {
    const l = twoDone();
    l.thread("chk", "check", "w:1:open");
    l.status("chk:start", "chk", "a", "w:1:open", "under-review", l.rule("check-start"));
    l.checkpoint("chk:1", "chk", "a", "w:1:open", { verdict: "passed", text: "Reproduced 3.39." });
    l.status("chk:result", "chk", "a", "w:1:open", "done", l.rule("check-result"));
    const f = fold(l.events);
    expect(f.revisions).toHaveLength(1);
    const a = f.tasks[0];
    expect(a?.status).toBe("done");
    expect(a?.checker).toEqual({ verdict: "passed", text: "Reproduced 3.39." });
    expect(a?.threads).toEqual({ worker: W, check: "chk" });
    expect(a?.checks).toEqual([]);
    expect(a?.resultRevisionId).toBe("root:revision");
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
    l.status("chk:result", "chk", "a", "w:1:open", "to-check", l.rule("check-result"));
    const f = fold(l.events);
    const [r1, r2] = f.revisions;
    expect(f.revisions.map((r) => r.reason)).toEqual(["run", "fix"]);
    const before = r1?.tasks[0];
    expect(before?.status).toBe("under-review"); // its status at that point in the log
    expect(before?.measurements.map((m) => m.value)).toEqual([3.4]);
    expect(before?.checks).toEqual([]);
    const after = r2?.tasks[0];
    expect(after?.status).toBe("to-check");
    expect(after?.measurements.map((m) => [m.id, m.value])).toEqual([
      ["a/width", 3.39],
      ["a/area", 12],
    ]);
    expect(after?.evidence.map((e) => e.sha256)).toEqual([SHA(1), SHA(2)]);
    expect(after?.threads).toEqual({ worker: W, check: "chk" });
    expect(after?.checker?.verdict).toBe("passed");
    expect(after?.checks.map((c) => c.title)).toEqual([
      "Marked to check",
      "Changed by the second agent",
    ]);
    expect(after?.checks[1]?.id).toBe("chk:2:revision");
    expect(r1?.tasks[1]?.resultRevisionId).toBe("root:revision");
    expect(r2?.tasks[1]).toMatchObject({ status: "stale", resultRevisionId: "chk:2:revision" });
    expect(after?.resultRevisionId).toBe("chk:2:revision");
    expectParses(f);
  });

  it("a verdict from a non-check thread is ignored", () => {
    const l = twoDone();
    l.checkpoint("w:7", W, "a", "w:1:open", { verdict: "passed" });
    const f = fold(l.events);
    expect(f.tasks[0]?.checker).toBeNull();
    expect(f.tasks[0]?.milestones.at(-1)?.verdict).toBeUndefined();
  });

  it("a correction during a check leaves the task stale", () => {
    const l = twoDone();
    l.thread("chk", "check", "w:1:open");
    l.status("chk:start", "chk", "a", "w:1:open", "under-review", l.rule("check-start"));
    l.revision("sup:1:revision", SUP, { reason: "correction", taskId: "a" });
    l.status("sup:1", SUP, "a", "w:1:open", "stale");
    // The runtime stopped the check, so no check-result follows.
    const f = fold(l.events);
    expect(f.tasks[0]).toMatchObject({ status: "stale", resultRevisionId: "sup:1:revision" });
    expect(f.revisions[0]?.tasks[0]?.status).toBe("under-review");
    expectParses(f);
  });

  it("a stale mark mid-attempt: the redo is a new attempt, the earlier writes stay behind", () => {
    const l = log();
    l.revision("root:revision", "root", { reason: "run" });
    l.open("w:1:open", W, "b");
    l.value("w:1", W, "b", "w:1:open", "old", 1);
    l.revision("sup:1:revision", SUP, { reason: "correction", taskId: "a" });
    l.status("sup:1:stale:b", SUP, "b", "w:1:open", "stale", l.rule("stale"));
    l.value("w:2", W, "b", "w:1:open", "late", 2); // would be refused; stamped on the old attempt
    l.open("w:3:open", W, "b");
    l.status("w:3", W, "b", "w:3:open", "in-progress");
    l.value("w:4", W, "b", "w:3:open", "new", 3);
    const f = fold(l.events);
    const [r1, r2] = f.revisions;
    expect(r1?.tasks[0]?.measurements.map((m) => m.id)).toEqual(["b/old"]);
    expect(r1?.tasks[0]?.status).toBe("in-progress");
    expect(r2?.tasks[0]?.attemptId).toBe("w:3:open");
    expect(r2?.tasks[0]?.measurements.map((m) => m.id)).toEqual(["b/new"]);
    expectParses(f);
  });

  it("the stuck guard marks an unfinished task to check", () => {
    const l = log();
    l.revision("root:revision", "root", { reason: "run" });
    l.open("w:1:open", W, "a");
    l.status("w:1", W, "a", "w:1:open", "in-progress");
    l.status("w:stuck:a", W, "a", "w:1:open", "to-check", l.rule("stuck"));
    const f = fold(l.events);
    expect(f.tasks[0]?.checks).toEqual([
      { id: "w:stuck:a", title: "Marked to check", detail: "to-check (w:stuck:a)", status: "open" },
    ]);
    expectParses(f);
  });

  it("a toCheck checkpoint is the item; the status event adds none", () => {
    const l = twoDone();
    l.checkpoint("w:7", W, "a", "w:1:open", { toCheck: { title: "Plane" }, text: "Unsure" });
    l.status("w:8", W, "a", "w:1:open", "to-check");
    const f = fold(l.events);
    expect(f.tasks[0]?.checks).toEqual([
      { id: "w:7", title: "Plane", detail: "Unsure", status: "open" },
    ]);
  });

  it("a duplicate event id after a resume changes nothing", () => {
    const l = twoDone();
    const once = fold(l.events);
    const dup = [...l.events, ...l.events.slice(2)];
    expect(fold(dup)).toEqual(once);
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
    const ratio = (r: typeof r1) => r?.tasks[2]?.measurements;
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
