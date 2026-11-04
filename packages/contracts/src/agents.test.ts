/**
 * `agentLog`'s delivery accounting for main: its cursor moves only when a delivery's user message
 * is stored, and a wrong cursor loses or repeats notices without any error.
 */
import { describe, expect, it } from "vitest";
import { agentLog } from "./agents";
import type { RunEvent } from "./events";

type Input = { covers: string };

function build() {
  const events: RunEvent[] = [];
  const add = (type: string, id: string, threadId: string, payload: object) =>
    events.push({
      id,
      runId: "run1",
      threadId,
      createdAt: new Date(Date.UTC(2026, 9, 28, 0, 0, events.length)).toISOString(),
      seq: events.length,
      type,
      payload,
    } as RunEvent);
  const sender = (i: Input) => ({ kind: "runtime", covers: i.covers });
  return {
    events,
    notice: (id: string) => add("agent.message", id, "w", { from: "w", to: "main", text: id }),
    ping: (id: string) => add("ping", id, "main", { threadId: "main" }),
    start: (id: string, input?: Input) =>
      add("thread.started", id, "main", {
        name: "main",
        parentThreadId: "root",
        workflows: [],
        kind: "supervisor",
        role: "main",
        ...(input && { input: { text: "t", sender: sender(input) } }),
      }),
    message: (id: string, input: Input) =>
      add("message", id, "main", { role: "user", text: "t", sender: sender(input) }),
  };
}

const ids = (l: ReturnType<typeof agentLog>) => l.undelivered.map((n) => n.eventId);

describe("agentLog main cursor", () => {
  it("leaves a notice stored between a start's covers and its message undelivered", () => {
    const b = build();
    b.notice("n1");
    b.start("s1", { covers: "n1" });
    b.notice("n2");
    b.message("m1", { covers: "n1" });
    const l = agentLog(b.events);
    expect(l.cursor).toBe("n1");
    expect(ids(l)).toEqual(["n2"]);
  });

  it("does not move the cursor for a ping", () => {
    const b = build();
    b.notice("n1");
    b.ping("p1");
    b.start("s1", { covers: "p1" });
    b.message("m1", { covers: "p1" });
    const l = agentLog(b.events);
    expect(l.cursor).toBeUndefined();
    expect(ids(l)).toEqual(["n1"]);
  });

  it("keeps notices undelivered when the start's message never lands", () => {
    const b = build();
    b.notice("n1");
    b.start("s1", { covers: "n1" });
    const l = agentLog(b.events);
    expect(l.cursor).toBeUndefined();
    expect(ids(l)).toEqual(["n1"]);
  });

  it("counts a send and a later message with the same covers as one delivery", () => {
    const b = build();
    b.start("s0");
    b.notice("n0");
    b.message("brief", { covers: "n0" });
    b.notice("n1");
    b.message("m1", { covers: "n1" });
    b.message("m2", { covers: "n1" });
    expect(agentLog(b.events).emptyDeliveries).toBe(0);
  });

  it("does not move the cursor back to an earlier snapshot", () => {
    const b = build();
    b.start("s0");
    b.notice("n1");
    b.notice("n2");
    b.message("m1", { covers: "n2" });
    b.message("m2", { covers: "n1" });
    const l = agentLog(b.events);
    expect(l.cursor).toBe("n2");
    expect(ids(l)).toEqual([]);
  });
});

describe("agentLog review main", () => {
  const log = () => {
    const events: RunEvent[] = [];
    const add = (type: string, id: string, threadId: string, payload: object) =>
      events.push({
        id,
        runId: "run1",
        threadId,
        createdAt: new Date(Date.UTC(2026, 9, 28, 0, 0, events.length)).toISOString(),
        seq: events.length,
        type,
        payload,
      } as RunEvent);
    const started = (id: string, name: string) =>
      add("thread.started", id, name, {
        name,
        parentThreadId: "root",
        workflows: [],
        kind: "supervisor",
        role: "main",
      });
    return { events, add, started };
  };

  it("marks a main first started while reviewing, and keeps it across its resumes", () => {
    const b = log();
    b.started("main", "main");
    b.add("thread.ended", "e0", "root", { status: "completed" });
    b.add("run.reopened", "r1", "root", {});
    b.started("main:resumed", "main");
    b.started("main.2", "main.2");
    b.started("main.2:resumed", "main.2");
    const { records } = agentLog(b.events);
    expect(records.get("main")?.review).toBe(false);
    expect(records.get("main.2")?.review).toBe(true);
  });
});
