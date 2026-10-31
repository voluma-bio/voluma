import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import type { Files } from "../../ports/files";
import type { History } from "../../ports/history";
import { foldHistory } from "./compaction";
import { repairToolPairs } from "./history-repair";
import { withImageRefs } from "./image-refs";

const user = (text: string) => ({ role: "user", content: text, timestamp: 1 }) as AgentMessage;
const call = (id: string) =>
  ({
    role: "assistant",
    content: [{ type: "toolCall", id, name: "bash", arguments: {} }],
    stopReason: "toolUse",
  }) as unknown as AgentMessage;
const result = (id: string) =>
  ({
    role: "toolResult",
    toolCallId: id,
    toolName: "bash",
    content: [{ type: "text", text: "ok" }],
  }) as unknown as AgentMessage;

describe("read-time repair is a pure function of the stored rows", () => {
  it("an unreadable row becomes a fixed note, an unreadable marker is skipped", () => {
    const rows = [
      JSON.stringify(user("a")),
      "{not json",
      '{"role":"compaction","summary":',
      JSON.stringify(user("b")),
    ];
    const before = [...rows];
    const first = foldHistory(rows);
    expect(JSON.stringify(foldHistory(rows))).toBe(JSON.stringify(first));
    expect(rows).toEqual(before);
    expect(first.messages).toHaveLength(3);
    expect(first.compaction).toBeUndefined();
    expect(first.unreadable).toEqual([
      { idx: 1, rule: "unreadable-message" },
      { idx: 2, rule: "unreadable-marker" },
    ]);
  });

  it("an unanswered call mid-history gets a fixed result and a stray result is left out", () => {
    const messages = [user("a"), call("c1"), user("b"), result("c2"), call("c3"), result("c3")];
    const before = JSON.stringify(messages);
    const repaired = repairToolPairs(messages, undefined, () => {});
    expect(JSON.stringify(repairToolPairs(messages, undefined, () => {}))).toBe(
      JSON.stringify(repaired),
    );
    expect(JSON.stringify(messages)).toBe(before);
    expect(repaired.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
      "user",
      "assistant",
      "toolResult",
    ]);
    expect((repaired[2] as { toolCallId: string }).toolCallId).toBe("c1");
    expect(repairToolPairs([user("a"), call("c"), result("c")], undefined, () => {})).toHaveLength(
      3,
    );
  });

  it("an image that keeps failing to read becomes a note, the same on every load", async () => {
    const stored: string[] = [];
    const history: History = {
      load: async () => stored,
      appendMessage: async (_t, _i, m) => {
        stored.push(m);
      },
    };
    const files: Files = {
      // biome-ignore lint/correctness/useYield: always fails
      async *read() {
        throw new Error("r2 down");
      },
      async write() {},
      async list() {
        return [];
      },
    };
    const wrapped = withImageRefs(history, files, "r1", () => "t1.worker");
    await wrapped.appendMessage(
      "r1.t1.worker",
      0,
      JSON.stringify({
        role: "toolResult",
        content: [{ type: "image", mimeType: "image/png", data: "AAAA" }],
      }),
    );
    const before = [...stored];
    const first = await wrapped.load("r1.t1.worker");
    expect(JSON.parse(first[0] as string).content[0].text).toMatch(/could not be read/);
    expect(await wrapped.load("r1.t1.worker")).toEqual(first);
    expect(stored).toEqual(before);
  });
});
