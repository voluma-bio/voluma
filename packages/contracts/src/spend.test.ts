/**
 * Thread time across resumes, which the run screen's clocks showed wrong twice: a resumed
 * thread keeps the time of its earlier stretches, and a cancel after its end adds none.
 */
import { describe, expect, it } from "vitest";
import type { RunEvent } from "./events";
import { spend } from "./spend";

/** A log under construction; `seq` is also the time in seconds. */
function log() {
  const events: RunEvent[] = [];
  const add = (type: RunEvent["type"], id: string, threadId: string, payload: object) => {
    const seq = events.length;
    events.push({
      id,
      runId: "run1",
      threadId,
      createdAt: new Date(Date.UTC(2026, 9, 28, 0, 0, seq)).toISOString(),
      seq,
      type,
      payload,
    } as RunEvent);
  };
  return { events, add };
}

const root = {
  name: "supervisor",
  parentThreadId: null,
  kind: "supervisor",
  workflows: [{ repo: "o/w", commit: "a".repeat(40) }],
};
const worker = { name: "w", parentThreadId: "sup", kind: "worker", role: "worker" };
const ping = (l: ReturnType<typeof log>, id: string, thread: string) =>
  l.add("ping", id, thread, {});

describe("spend per thread", () => {
  it("a thread's time is every stretch; a later end adds none", () => {
    const l = log();
    l.add("thread.started", "sup:1", "sup", root); // 0
    l.add("thread.started", "w:1", "w", worker); // 1
    l.add("thread.ended", "w:end", "w", { status: "completed" }); // 2: first stretch 1 s
    l.add("thread.ended", "w:cancel", "w", { status: "cancelled" }); // 3: a cancel adds nothing
    l.add("thread.started", "w:2", "w", worker); // 4: a resume
    ping(l, "w:p", "w"); // 5: the open stretch runs to its last event, 1 s
    const s = spend(l.events);
    const w = s.threads.find((t) => t.threadId === "w");
    expect(w?.spend.wallSeconds).toBe(2);
    expect(w?.endedSeconds).toBe(1);
    expect(w?.openSince).toBe(l.events[4]?.createdAt);
    // The root's open span runs to the log's latest event: the run's own working time.
    expect(s.total.wallSeconds).toBe(5);
  });

  it("a resume with no end closes the open stretch at the thread's last event", () => {
    const l = log();
    l.add("thread.started", "sup:1", "sup", root); // 0
    l.add("thread.started", "w:1", "w", worker); // 1
    ping(l, "w:p", "w"); // 2: cut off here, no end: 1 s
    l.add("thread.started", "w:2", "w", worker); // 3: a resume
    ping(l, "w:p2", "w"); // 4: the new stretch, 1 s
    const w = spend(l.events).threads.find((t) => t.threadId === "w");
    expect(w?.endedSeconds).toBe(1);
    expect(w?.spend.wallSeconds).toBe(2);
    expect(w?.openSince).toBe(l.events[3]?.createdAt);
  });
});
