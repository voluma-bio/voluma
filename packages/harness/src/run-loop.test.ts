/**
 * The run loop's guarantees, shown on whole runs: the real harness, Pi's agent loop and the
 * fold, with a scripted model and in-memory stores (`run-world.ts`). Each test is one scenario
 * of the runtime spec's Verification list and asserts on the stored event log.
 */
import type { RunEvent } from "@voluma/contracts/events";
import { describe, expect, it } from "vitest";
import {
  call,
  checker,
  first,
  hang,
  measurement,
  openAskIds,
  type Script,
  sleep,
  type Turn,
  task,
  worker,
  world,
} from "./run-world";

const R = "r1.";
const T1 = [task("t1"), task("t2", ["t1"])];

const started = (t: Turn, taskId: string) =>
  t.calls.some((c) => c.name === "start_worker" && c.input.taskId === taskId);
const told = (t: Turn, re: RegExp) => t.users.some((u) => re.test(u));
const passed = (t: Turn, taskId: string) => told(t, new RegExp(`The check of ${taskId} passed`));

/** Main for the usual chain: start each task when its dependency passed; finish when all passed. */
const chain =
  (tasks: string[]): Script =>
  (t) => {
    if (!t.fresh) return "Waiting.";
    for (const [i, id] of tasks.entries()) {
      if (started(t, id)) continue;
      if (i === 0 || passed(t, tasks[i - 1] as string))
        return call("start_worker", { taskId: id, brief: `Measure ${id}.` });
    }
    if (tasks.every((id) => passed(t, id)) && !t.results.some((r) => /run is finished/.test(r)))
      return call("finish_run", { summary: "Done." });
    return call("wait");
  };

const of = (events: readonly RunEvent[], type: RunEvent["type"], thread?: string) =>
  events.filter((e) => e.type === type && (thread === undefined || e.threadId === `${R}${thread}`));
const taskEvents = (events: readonly RunEvent[], taskId: string) =>
  events.flatMap((e) =>
    e.type === "task" && e.payload.taskId === taskId
      ? [
          `${e.payload.status}:${e.payload.by.kind === "rule" ? e.payload.by.rule : e.payload.by.kind}`,
        ]
      : [],
  );
const ended = (events: readonly RunEvent[], thread: string) =>
  of(events, "thread.ended", thread).map((e) =>
    e.type === "thread.ended" ? e.payload.status : "",
  );
const duplicates = (events: readonly RunEvent[]) => {
  const ids = events.map((e) => e.id);
  return ids.filter((id, i) => ids.indexOf(id) !== i);
};

describe("run loop", () => {
  it("happy path: two workers pass their checks and the run finishes", async () => {
    const w = world({ plan: T1, main: chain(["t1", "t2"]), check: checker() });
    const folded = await w.run();
    expect(folded.tasks.map((t) => `${t.id}:${t.status}`)).toEqual(["t1:done", "t2:done"]);
    expect(taskEvents(w.stored, "t1")).toContain("done:check-result");
    expect(ended(w.stored, "supervisor").at(-1)).toBe("completed");
    expect(duplicates(w.stored)).toEqual([]);
    expect(of(w.stored, "thread.started", "t1.worker")).toHaveLength(1);
    expect(of(w.stored, "thread.started", "t1.check")).toHaveLength(1);
  });

  it("needs-review: main's feedback resumes the same worker, whose new attempt passes", async () => {
    const feedback: Script = (t) => {
      const m = /The check of (t\d) found problems/.exec(t.lastUser);
      return t.fresh && m
        ? call("message", { threadId: `${R}${m[1]}.worker`, text: "Redo the placement." })
        : undefined;
    };
    const w = world({
      plan: T1,
      main: first(feedback, chain(["t1", "t2"])),
      check: checker((id, n) => (id === "t1" && n === 1 ? "needs-review" : "passed")),
    });
    const folded = await w.run();
    expect(folded.tasks.map((t) => `${t.id}:${t.status}`)).toEqual(["t1:done", "t2:done"]);
    // The first check rejected t1 (to-check, rejected until main acts); the second passed it.
    expect(taskEvents(w.stored, "t1")).toEqual([
      "under-review:agent",
      "to-check:check-result",
      "under-review:agent",
      "done:check-result",
    ]);
    // The same worker thread, resumed: two starts, no second worker, two attempts it opened.
    expect(of(w.stored, "thread.started", "t1.worker")).toHaveLength(2);
    expect(of(w.stored, "thread.started", "t1.worker.2")).toHaveLength(0);
    expect(of(w.stored, "attempt.opened", "t1.worker")).toHaveLength(2);
    // Main's feedback reached the worker as its user message; the new attempt got a new check.
    const toWorker = of(w.stored, "message", "t1.worker").flatMap((e) =>
      e.type === "message" && e.payload.role === "user" ? [e.payload.text] : [],
    );
    expect(toWorker.at(-1)).toContain("Redo the placement.");
    expect(of(w.stored, "thread.started", "t1.check")).toHaveLength(1);
    expect(of(w.stored, "thread.started", "t1.check.2")).toHaveLength(1);
    expect(duplicates(w.stored)).toEqual([]);
  });

  it("fix limit stops feedback; an upstream correction makes the task stale and it can be redone", async () => {
    const main: Script = (t) => {
      const lastResult = t.results.at(-1) ?? "";
      const sent = (to: string) =>
        t.calls.some((c) => c.name === "message" && c.input.threadId === `${R}${to}`);
      if (!t.fresh) {
        if (/used its fix rounds/.test(lastResult) && !sent("t1.worker"))
          return call("message", {
            threadId: `${R}t1.worker`,
            text: "Redo t1 with another method.",
          });
        // t2's old worker is still there (idle): stop it, then start a new one.
        if (/has a worker/.test(lastResult))
          return call("stop_worker", { threadId: `${R}t2.worker`, reason: "Redoing t2." });
        if (/is stopped\.|stopped\./.test(lastResult))
          return call("start_worker", { taskId: "t2", brief: "Redo t2 on the corrected t1." });
        return "Waiting.";
      }
      if (/used its fix rounds/.test(t.lastUser))
        return call("message", { threadId: `${R}t2.worker`, text: "One more try." });
      if (/t2 is rejected/.test(t.lastUser))
        return call("message", { threadId: `${R}t2.worker`, text: "Redo the placement." });
      // Redo t2 once t1 passes again after its correction made t2 stale.
      const redone = t.calls.some((c) => c.name === "stop_worker");
      if (told(t, /t2 is stale/) && /The check of t1 passed/.test(t.lastUser) && !redone)
        return call("start_worker", { taskId: "t2", brief: "Redo t2 on the corrected t1." });
      if (redone && passed(t, "t2")) return call("finish_run", { summary: "Done." });
      if (told(t, /t2 is stale/)) return call("wait");
      return chain(["t1", "t2"])(t);
    };
    // t2's first two checks reject it; every later check passes.
    const w = world({
      plan: T1,
      main,
      check: checker((id, n) => (id === "t2" && n <= 2 ? "needs-review" : "passed")),
    });
    const folded = await w.run();
    expect(
      folded.tasks.map((t) => `${t.id}:${t.status}`),
      w.text(),
    ).toEqual(["t1:done", "t2:done"]);
    const t2 = taskEvents(w.stored, "t2");
    expect(t2).toContain("to-check:fix-limit");
    expect(t2).toContain("stale:stale");
    // Feedback after the limit was refused.
    const refused = of(w.stored, "tool.result", "main").filter(
      (e) => e.type === "tool.result" && e.payload.isError && /fix rounds/.test(e.payload.output),
    );
    expect(refused).toHaveLength(1);
    // t1's redo corrected it; main replaced t2's worker and the new one did t2.
    expect(of(w.stored, "revision.started")).toHaveLength(2); // the run's own, and t1's correction
    expect(of(w.stored, "thread.started", "t2.worker.2")).toHaveLength(1);
    expect(duplicates(w.stored)).toEqual([]);
  });

  describe("a checker's question", () => {
    /** A checker for t2 that asks first and gives its verdict only once it has the answer. */
    const asking = () => {
      const inner = checker();
      return (t: Turn) => {
        if (t.task !== "t2") return inner(t);
        if (!t.calls.some((c) => c.name === "ask"))
          return call("ask", { question: "Is the scan isotropic?" });
        return told(t, /The main agent answers/) ? inner(t) : "I am waiting for the answer.";
      };
    };
    const answering: Script = (t) => {
      const [askId] = openAskIds(t);
      return t.fresh && askId
        ? call("answer", { askId, text: "Yes, the scan is isotropic." })
        : undefined;
    };

    it("ask -> answer -> verdict: the same checker resumes with the answer and then judges", async () => {
      const w = world({ plan: T1, main: first(answering, chain(["t1", "t2"])), check: asking() });
      const folded = await w.run();
      expect(
        folded.tasks.map((t) => `${t.id}:${t.status}`),
        w.text(),
      ).toEqual(["t1:done", "t2:done"]);
      const [ask] = of(w.stored, "ask", "t2.check");
      const [answer] = of(w.stored, "answer");
      expect(ask && answer && answer.type === "answer" && answer.payload.askId).toBe(ask?.id);
      // The checker was resumed (a second start of the same thread), told the answer, and its
      // verdict came after the answer.
      expect(of(w.stored, "thread.started", "t2.check")).toHaveLength(2);
      expect(of(w.stored, "thread.started", "t2.check.2")).toHaveLength(0);
      const told2 = of(w.stored, "message", "t2.check").flatMap((e) =>
        e.type === "message" && e.payload.role === "user" ? [e.payload.text] : [],
      );
      expect(told2.at(-1)).toContain("Yes, the scan is isotropic.");
      const at = (id: string | undefined) => w.stored.findIndex((e) => e.id === id);
      const verdict = w.stored.findIndex(
        (e) => e.type === "checkpoint" && e.threadId === `${R}t2.check`,
      );
      expect(at(ask?.id)).toBeLessThan(at(answer?.id));
      expect(at(answer?.id)).toBeLessThan(verdict);
      expect(duplicates(w.stored)).toEqual([]);
    });

    it("a restart while the checker waits on an answer: the answer is given once and the checker judges after it", async () => {
      // Cut when main has just been told of the ask, before it answers.
      const w = world({
        plan: T1,
        main: first(answering, chain(["t1", "t2"])),
        check: asking(),
        cutAfter: (e) =>
          e.type === "message" &&
          e.threadId === `${R}main` &&
          e.payload.role === "user" &&
          e.payload.sender.kind === "runtime" &&
          /askId/.test(e.payload.text),
      });
      const folded = await w.run();
      expect(w.wasCut).toBe(true);
      expect(
        folded.tasks.map((t) => `${t.id}:${t.status}`),
        w.text(),
      ).toEqual(["t1:done", "t2:done"]);
      expect(of(w.stored, "ask", "t2.check")).toHaveLength(1);
      expect(of(w.stored, "answer")).toHaveLength(1);
      expect(of(w.stored, "thread.started", "t2.check.2")).toHaveLength(0);
      // The checker was never asked to judge before it had the answer.
      const answerAt = w.stored.findIndex((e) => e.type === "answer");
      const verdictAt = w.stored.findIndex(
        (e) => e.type === "checkpoint" && e.threadId === `${R}t2.check`,
      );
      expect(answerAt).toBeGreaterThan(-1);
      expect(verdictAt).toBeGreaterThan(answerAt);
      expect(taskEvents(w.stored, "t2")).toEqual(["under-review:agent", "done:check-result"]);
      expect(duplicates(w.stored)).toEqual([]);
    });
  });

  it("check deadline: a check that outlives its active time is stopped and the task is left to-check", async () => {
    // t1's checker never answers its first request, so it is still running at the deadline.
    const stuck: Script = (t) => (t.task === "t1" ? hang(t) : undefined);
    const main: Script = (t) => {
      if (t.fresh && /ran out of time/.test(t.lastUser) && !started(t, "t2"))
        return call("start_worker", { taskId: "t2", brief: "Measure t2." });
      if (t.fresh && passed(t, "t2")) return call("finish_run", { summary: "Done." });
      return t.fresh ? call("wait") : "Waiting.";
    };
    const w = world({
      plan: T1,
      main: first((t) => (t.users.length === 1 ? chain(["t1"])(t) : undefined), main),
      check: first(stuck, checker()),
      config: { checkTimeoutMs: 250 },
    });
    const folded = await w.run();
    expect(
      folded.tasks.map((t) => `${t.id}:${t.status}`),
      w.text(),
    ).toEqual(["t1:to-check", "t2:done"]);
    expect(taskEvents(w.stored, "t1")).toEqual(["under-review:agent", "to-check:check-limit"]);
    expect(ended(w.stored, "t1.check")).toEqual(["cancelled"]);
    expect(w.stored.some((e) => e.type === "checkpoint" && e.threadId === `${R}t1.check`)).toBe(
      false,
    );
  });

  // Known failure of the loop: `staleDependents` stops only a dependent's live thread, picked by
  // its status (`in-progress`: worker, `under-review`: check). A dependent that is `done` or
  // `to-check` keeps its idle worker, which then also blocks `start_worker` on the stale task.
  it.fails("redo with attempted dependents: a correction marks them stale and stops their worker", async () => {
    const main: Script = (t) => {
      const redo = t.calls.some((c) => c.name === "message");
      if (t.fresh && passed(t, "t2") && !redo)
        return call("message", { threadId: `${R}t1.worker`, text: "Redo t1 with another method." });
      if (!t.fresh) return "Waiting.";
      return redo ? call("wait") : chain(["t1", "t2"])(t);
    };
    const w = world({ plan: T1, main });
    await w.run();
    const corrections = of(w.stored, "revision.started").filter(
      (e) => e.type === "revision.started" && e.payload.reason === "correction",
    );
    expect(corrections).toHaveLength(1);
    expect(taskEvents(w.stored, "t2")).toContain("stale:stale");
    // The stale task's worker is stopped, so it cannot redo the task ahead of what it builds on.
    expect(ended(w.stored, "t2.worker").at(-1), w.text()).toBe("cancelled");
  });

  describe("a cut-off in the middle of a tool call", () => {
    const resultsOf = (events: readonly RunEvent[], thread: string) =>
      of(events, "tool.result", thread).flatMap((e) =>
        e.type === "tool.result" ? [e.payload.output] : [],
      );
    const userTexts = (events: readonly RunEvent[], thread: string) =>
      of(events, "message", thread).flatMap((e) =>
        e.type === "message" && e.payload.role === "user" ? [e.payload.text] : [],
      );

    it("start_worker: the worker is not started twice and main is told it was", async () => {
      const w = world({
        plan: T1,
        main: chain(["t1", "t2"]),
        cutAfter: (e) => e.id.endsWith(":start_worker"),
      });
      const folded = await w.run();
      expect(w.wasCut).toBe(true);
      expect(
        folded.tasks.map((t) => `${t.id}:${t.status}`),
        w.text(),
      ).toEqual(["t1:done", "t2:done"]);
      expect(
        w.stored.filter((e) => e.type === "thread.started" && e.payload.spawnedBy),
      ).toHaveLength(2);
      expect(of(w.stored, "thread.started", "t1.worker.2")).toHaveLength(0);
      expect(
        resultsOf(w.stored, "main").some((r) =>
          /start_worker.*completed before the run was cut off/.test(r),
        ),
      ).toBe(true);
      expect(duplicates(w.stored)).toEqual([]);
    });

    it("submit_task: the task is submitted once and checked once, and the worker is not restarted", async () => {
      const w = world({
        plan: T1,
        main: chain(["t1", "t2"]),
        cutAfter: (e) =>
          e.type === "task" && e.payload.taskId === "t1" && e.payload.status === "under-review",
      });
      const folded = await w.run();
      expect(w.wasCut).toBe(true);
      expect(
        folded.tasks.map((t) => `${t.id}:${t.status}`),
        w.text(),
      ).toEqual(["t1:done", "t2:done"]);
      expect(taskEvents(w.stored, "t1")).toEqual(["under-review:agent", "done:check-result"]);
      expect(of(w.stored, "thread.started", "t1.check")).toHaveLength(1);
      expect(of(w.stored, "thread.started", "t1.check.2")).toHaveLength(0);
      // The worker's task is under review, so it is not in charge any more: it is not resumed.
      expect(of(w.stored, "thread.started", "t1.worker")).toHaveLength(1);
      // Main hears of the submission once, whether before or after the restart.
      expect(userTexts(w.stored, "main").filter((u) => /t1\) submitted t1/.test(u))).toHaveLength(
        1,
      );
      expect(duplicates(w.stored)).toEqual([]);
    });

    // Known failure of the loop: `interruptedResult` tells main the `message` completed because the
    // attempt it opens is stored, but the worker's copy of the feedback is written after it. A cut
    // in between leaves the worker idle on an open attempt, and nothing resumes an idle worker.
    it.fails("message: the feedback opens one attempt and the worker has it after the restart", async () => {
      const feedback: Script = (t) => {
        const m = /The check of (t\d) found problems/.exec(t.lastUser);
        return t.fresh && m
          ? call("message", { threadId: `${R}${m[1]}.worker`, text: "Redo the placement." })
          : undefined;
      };
      const w = world({
        plan: T1,
        main: first(feedback, chain(["t1", "t2"])),
        check: checker((id, n) => (id === "t1" && n === 1 ? "needs-review" : "passed")),
        cutAfter: (e) => e.id.endsWith(":message:open"),
      });
      const folded = await w.run();
      expect(w.wasCut).toBe(true);
      expect(
        folded.tasks.map((t) => `${t.id}:${t.status}`),
        w.text(),
      ).toEqual(["t1:done", "t2:done"]);
      expect(of(w.stored, "attempt.opened", "t1.worker")).toHaveLength(2);
      expect(of(w.stored, "thread.started", "t1.worker.2")).toHaveLength(0);
      expect(
        userTexts(w.stored, "t1.worker").filter((u) => /Redo the placement/.test(u)),
      ).toHaveLength(1);
      expect(
        resultsOf(w.stored, "main").some((r) =>
          /message.*completed before the run was cut off/.test(r),
        ),
      ).toBe(true);
      expect(duplicates(w.stored)).toEqual([]);
    });
  });

  it("a notice appended after a delivery was built is delivered next time, once", async () => {
    // t2's worker waits until main has been handed the delivery about t1, then submits.
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const gated: Script = (t) =>
      t.thread === `${R}t2.worker` && t.steps === 0 ? gate.then(() => undefined) : undefined;
    const main: Script = (t) => {
      if (!t.fresh) return "Waiting.";
      if (t.calls.length === 0)
        return [
          call("start_worker", { taskId: "t1", brief: "t1." }),
          call("start_worker", { taskId: "t2", brief: "t2." }),
        ];
      if (passed(t, "t1") && passed(t, "t2")) return call("finish_run", { summary: "Done." });
      return call("wait");
    };
    const w = world({
      plan: [task("t1"), task("t2")],
      main,
      worker: first(gated, worker),
      onStored: (e) => {
        if (
          e.type === "message" &&
          e.payload.role === "user" &&
          e.payload.sender.kind === "runtime" &&
          /check of t1 passed/.test(e.payload.text)
        )
          release();
      },
    });
    const folded = await w.run();
    expect(
      folded.tasks.map((t) => `${t.id}:${t.status}`),
      w.text(),
    ).toEqual(["t1:done", "t2:done"]);
    const deliveries = of(w.stored, "message", "main").flatMap((e) =>
      e.type === "message" && e.payload.role === "user" && e.payload.sender.kind === "runtime"
        ? [{ text: e.payload.text, covers: e.payload.sender.covers }]
        : [],
    );
    const indexOf = (id: string | undefined) => w.stored.findIndex((e) => e.id === id);
    const first1 = deliveries.findIndex((d) => /check of t1 passed/.test(d.text));
    const submitted = deliveries.flatMap((d, i) => (/t2\) submitted t2/.test(d.text) ? [i] : []));
    // t2's submission came after the first delivery's cursor, so it is in a later delivery, and only one.
    expect(first1).toBeGreaterThan(-1);
    expect(submitted).toHaveLength(1);
    expect(submitted[0]).toBeGreaterThan(first1);
    expect(indexOf(deliveries[submitted[0] as number]?.covers)).toBeGreaterThan(
      indexOf(deliveries[first1]?.covers),
    );
    // Every notice reaches main exactly once.
    for (const re of [/t1\) submitted t1/, /check of t1 passed/, /check of t2 passed/])
      expect(deliveries.filter((d) => re.test(d.text))).toHaveLength(1);
  });

  it("stop_worker: a report_output waiting on the runtime's section is refused once the worker is stopped", async () => {
    // Main stops t1's worker while the stop's own write is slow; the worker's report_output call
    // arrives in that window and waits for the section.
    const slowWorker: Script = async (t) => {
      if (t.thread === `${R}t1.worker` && t.steps === 0) await sleep(40);
      return undefined;
    };
    const main: Script = (t) => {
      if (t.calls.length === 0 && t.fresh)
        return [
          call("start_worker", { taskId: "t1", brief: "t1." }),
          call("stop_worker", { threadId: `${R}t1.worker`, reason: "Not now." }),
        ];
      if (!t.fresh) {
        const started2 = t.calls.filter((c) => c.name === "start_worker").length > 1;
        return t.calls.at(-1)?.name === "stop_worker" && !started2
          ? call("start_worker", { taskId: "t1", brief: "t1, again." })
          : "Waiting.";
      }
      return passed(t, "t1") ? call("finish_run", { summary: "Done." }) : call("wait");
    };
    const w = world({
      plan: [task("t1")],
      main,
      worker: first(slowWorker, worker),
      delayStore: (e) =>
        e.type === "thread.ended" &&
        e.threadId === `${R}t1.worker` &&
        e.payload.status === "cancelled"
          ? 120
          : 0,
    });
    const folded = await w.run();
    expect(
      folded.tasks.map((t) => `${t.id}:${t.status}`),
      w.text(),
    ).toEqual(["t1:done"]);
    expect(ended(w.stored, "t1.worker")).toEqual(["cancelled"]);
    // Nothing the stopped worker wrote after its stop: no output, no attempt.
    const stopAt = w.stored.findIndex(
      (e) => e.type === "thread.ended" && e.threadId === `${R}t1.worker`,
    );
    const after = w.stored.slice(stopAt + 1).filter((e) => e.threadId === `${R}t1.worker`);
    expect(
      after.map((e) => e.type).filter((t) => !["message", "tool.call", "tool.result"].includes(t)),
    ).toEqual([]);
    const answered = after.flatMap((e) => (e.type === "tool.result" ? [e.payload] : []));
    expect(answered.every((r) => r.isError)).toBe(true);
    expect(of(w.stored, "output", "t1.worker")).toHaveLength(0);
    expect(of(w.stored, "attempt.opened", "t1.worker")).toHaveLength(0);
    expect(of(w.stored, "attempt.opened", "t1.worker.2")).toHaveLength(1);
  });

  it("finish_run is refused while a selected output is neither reported nor skipped", async () => {
    const main: Script = (t) => {
      if (t.calls.length === 0) return call("finish_run", { summary: "Done early." });
      if (!t.fresh && t.calls.length === 1)
        return call("start_worker", { taskId: "t1", brief: "t1." });
      return chain(["t1", "t2"])(t);
    };
    const w = world({ plan: T1, main });
    const folded = await w.run();
    const [refused] = of(w.stored, "tool.result", "main");
    expect(refused?.type === "tool.result" && refused.payload.isError).toBe(true);
    expect(refused?.type === "tool.result" && refused.payload.output).toMatch(
      /t1 has not run: required outputs not reported: m1/,
    );
    // The refused call ended nothing; the run finished only after both tasks were done.
    const finishAt = w.stored.findIndex((e) => e.id.endsWith(":finish_run"));
    const lastTask = [...w.stored]
      .reverse()
      .findIndex(
        (e) => e.type === "task" && e.payload.taskId === "t2" && e.payload.status === "done",
      );
    expect(finishAt).toBeGreaterThan(w.stored.length - 1 - lastTask);
    expect(folded.tasks.map((t) => `${t.id}:${t.status}`)).toEqual(["t1:done", "t2:done"]);
  });

  it("liveness: a main that only waits gets its wakes, then code skips what is left and ends the run", async () => {
    const w = world({ plan: T1, main: (t) => (t.fresh ? call("wait") : "Waiting.") });
    const folded = await w.run();
    const wakes = of(w.stored, "message", "main").filter(
      (e) =>
        e.type === "message" &&
        e.payload.role === "user" &&
        /Nothing is running/.test(e.payload.text),
    );
    expect(wakes).toHaveLength(2);
    const [changed] = of(w.stored, "plan.changed");
    expect(changed?.threadId).toBe(`${R}supervisor`);
    expect(changed?.type === "plan.changed" && changed.payload.skip?.map((s) => s.taskId)).toEqual([
      "t1",
      "t2",
    ]);
    expect(folded.tasks.every((t) => t.skipped)).toBe(true);
    expect(ended(w.stored, "supervisor").at(-1)).toBe("completed");
    expect(duplicates(w.stored)).toEqual([]);
  });

  it("main granted the worker's tools does a task itself, under the same rules", async () => {
    const main: Script = (t) => {
      if (t.fresh && t.calls.length === 0)
        return call("report_output", {
          taskId: "t1",
          outputId: "m1",
          title: "M",
          output: measurement(1.5),
          evidence: [],
        });
      if (!t.fresh && t.calls.length === 1)
        return call("submit_task", { taskId: "t1", summary: "t1 measured by main." });
      if (!t.fresh) return "Waiting.";
      if (passed(t, "t1") && !started(t, "t2"))
        return call("start_worker", { taskId: "t2", brief: "t2." });
      if (passed(t, "t1") && passed(t, "t2")) return call("finish_run", { summary: "Done." });
      return call("wait");
    };
    const w = world({ plan: T1, main, mainTools: ["report_output", "submit_task"] });
    const folded = await w.run();
    expect(
      folded.tasks.map((t) => `${t.id}:${t.status}`),
      w.text(),
    ).toEqual(["t1:done", "t2:done"]);
    // Main holds t1: it opened the attempt and reported under its own thread, and t1 was checked as any task is.
    expect(of(w.stored, "attempt.opened", "main")).toHaveLength(1);
    expect(of(w.stored, "output", "main")).toHaveLength(1);
    expect(of(w.stored, "thread.started", "t1.check")).toHaveLength(1);
    expect(of(w.stored, "thread.started", "t1.worker")).toHaveLength(0);
    expect(taskEvents(w.stored, "t1")).toEqual(["under-review:agent", "done:check-result"]);
  });
});
