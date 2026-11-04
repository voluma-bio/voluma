/**
 * What main got with your message attaches to that message (`threadRows`): by the delivery's
 * `covers` range, not by which of your messages came last. A wrong attachment raises no error;
 * it shows the AI answering words you didn't send.
 */
import type { RunEvent } from "@voluma/contracts/events";
import { describe, expect, it } from "vitest";
import { type Slot, threadRows } from "./transcript";

function build() {
  const events: RunEvent[] = [];
  const add = (type: string, id: string, threadId: string, payload: object) =>
    events.push({
      id,
      runId: "run1",
      threadId,
      createdAt: new Date(Date.UTC(2026, 10, 4, 0, 0, events.length)).toISOString(),
      seq: events.length + 1,
      type,
      payload,
    } as RunEvent);
  add("thread.started", "start", "main", {
    name: "main",
    parentThreadId: "root",
    workflows: [],
    role: "main",
  });
  return {
    events,
    person: (id: string) => add("person.message", id, "main", { text: id }),
    delivery: (id: string, covers: string) =>
      add("message", id, "main", {
        role: "user",
        text: `got ${covers}`,
        sender: { kind: "runtime", covers },
      }),
  };
}

const slotsOf = (events: readonly RunEvent[]): Slot[] =>
  events.flatMap((e) =>
    e.type === "person.message" ? [{ id: e.id, seq: e.seq, person: true }] : [],
  );

const got = (events: readonly RunEvent[]) =>
  threadRows(events, ["main"], true, { slots: slotsOf(events), conversation: true }).map((r) =>
    r.kind === "slot"
      ? `${r.id}: ${r.got ?? "-"}`
      : r.kind === "brief"
        ? `brief: ${r.text}`
        : r.kind,
  );

describe("threadRows: what main got with your message", () => {
  it("attaches each delivery to the message it covers, even with a later message placed", () => {
    const b = build();
    b.person("A");
    b.person("B");
    b.delivery("dA", "A");
    b.delivery("dB", "B");
    expect(got(b.events)).toEqual(["A: got A", "B: got B"]);
  });

  it("gives one delivery covering two messages to the last of them", () => {
    const b = build();
    b.person("A");
    b.person("B");
    b.delivery("d", "B");
    expect(got(b.events)).toEqual(["A: -", "B: got B"]);
  });
});
