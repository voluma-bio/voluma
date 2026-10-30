/**
 * Thread time across resumes, which the run screen's clocks showed wrong twice: a resumed
 * thread keeps the time of its earlier stretches, and a cancel after its end adds none.
 */
import { describe, expect, it } from "vitest";
import { log } from "./fold-test-log";
import { spend } from "./spend";

describe("spend per thread", () => {
  it("a thread's time is every stretch; a later end adds none; a task and main are sums", () => {
    const l = log();
    // `log()` stamps one second per event, so a seq is also its time in seconds.
    const worker = { parentThreadId: null, kind: "worker", task: "a" } as const;
    l.run(); // 0
    l.thread("sup", "supervisor"); // 1
    l.add("thread.started", "w:1", "w", worker); // 2
    l.add("thread.ended", "w:end", "w", { status: "completed" }); // 3: first stretch 1 s
    l.add("thread.ended", "w:cancel", "w", { status: "cancelled" }); // 4: a cancel adds nothing
    l.add("thread.started", "w:2", "w", worker); // 5: a resume
    l.checkpoint("w:cp", "w", "a", "att"); // 6: the open stretch runs to its last event, 1 s
    const s = spend(l.events);
    const w = s.threads.find((t) => t.threadId === "w");
    expect(w?.spend.wallSeconds).toBe(2);
    expect(w?.endedSeconds).toBe(1);
    expect(w?.openSince).toBe(l.events[5]?.createdAt);
    expect(s.tasks).toMatchObject([{ taskId: "a", spend: { wallSeconds: 2 } }]);
    // The root's open span runs to the log's latest event; main and total are the root's time.
    expect(s.main.wallSeconds).toBe(5);
    expect(s.total.wallSeconds).toBe(5);
  });
});
