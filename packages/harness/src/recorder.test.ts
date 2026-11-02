import type { EventInput, RunEvent } from "@voluma/contracts/events";
import { expect, test } from "vitest";
import { recorder } from "./recorder";

// A store the API also writes into: `server` appends an event without the runner.
function store() {
  const rows: RunEvent[] = [];
  const row = (e: { id: string; type: string }) =>
    ({ ...e, runId: "r", threadId: "t", seq: rows.length + 1, payload: {} }) as unknown as RunEvent;
  return {
    rows,
    server: (id: string) => rows.push(row({ id, type: "mark.placed" })),
    log: (answersSeq: boolean) => ({
      async append(e: EventInput) {
        const have = rows.find((r) => r.id === e.id);
        if (!have) rows.push(row(e));
        return answersSeq ? (have ?? rows.at(-1))?.seq : undefined;
      },
      eventsAfter: async (after: number, upTo = Number.POSITIVE_INFINITY) =>
        rows.filter((r) => r.seq > after && r.seq <= upTo),
    }),
  };
}

const ids = (events: readonly RunEvent[]) => events.map((e) => `${e.seq}:${e.id}`);

test("an API event written before the runner's own joins the view ahead of it", async () => {
  const s = store();
  const rec = recorder(s.log(true), "r", () => {});
  await rec.append("t", "tool.call", { toolCallId: "c", name: "bash", input: {} } as never, "a");
  s.server("m1");
  s.server("m2");
  await rec.append("t", "tool.call", { toolCallId: "d", name: "bash", input: {} } as never, "b");
  expect(ids(rec.events())).toEqual(["1:a", "2:m1", "3:m2", "4:b"]);
});

test("pull adds the tail once, and a retried append of a pulled id is a no-op", async () => {
  const s = store();
  const rec = recorder(s.log(true), "r", () => {});
  let pulled = 0;
  rec.onPulled(() => pulled++);
  s.server("m1");
  await rec.pull(1);
  await rec.pull(1);
  expect(ids(rec.events())).toEqual(["1:m1"]);
  expect(pulled).toBe(1);
  await rec.append("t", "tool.call", { toolCallId: "c", name: "bash", input: {} } as never, "a");
  expect(ids(rec.events())).toEqual(["1:m1", "2:a"]);
});

test("a store that answers no seq numbers each event after the view's last", async () => {
  const s = store();
  const rec = recorder(s.log(false), "r", () => {});
  await rec.append("t", "tool.call", { toolCallId: "c", name: "bash", input: {} } as never, "a");
  await rec.append("t", "tool.call", { toolCallId: "d", name: "bash", input: {} } as never, "b");
  expect(ids(rec.events())).toEqual(["1:a", "2:b"]);
});
