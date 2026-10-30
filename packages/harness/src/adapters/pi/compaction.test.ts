import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import { compactedView, cutPoint, foldHistory, inputTokens } from "./compaction";

const text = (n: number) => "x".repeat(n * 4); // n tokens
const user = (n: number): AgentMessage => ({ role: "user", content: text(n), timestamp: 0 });
const call = (id: string, n: number): AgentMessage =>
  ({
    role: "assistant",
    content: [{ type: "toolCall", id, name: "bash", arguments: { cmd: text(n) } }],
    stopReason: "toolUse",
  }) as never;
const result = (id: string, n: number): AgentMessage =>
  ({
    role: "toolResult",
    toolCallId: id,
    toolName: "bash",
    content: [{ type: "text", text: text(n) }],
  }) as never;
const system: AgentMessage = { role: "system", content: "s" } as never;

// system, user, then ten call/result pairs of ~100 tokens each
const thread = (): AgentMessage[] => [
  system,
  user(10),
  ...Array.from({ length: 10 }, (_, i) => [call(`c${i}`, 50), result(`c${i}`, 50)]).flat(),
];

describe("cutPoint", () => {
  it("keeps about the asked tokens and never starts at a tool result", () => {
    const messages = thread();
    for (let keep = 1; keep < 1100; keep += 7) {
      const cut = cutPoint(messages, 1, keep);
      if (cut === undefined) continue;
      expect(messages[cut]?.role).not.toBe("toolResult");
      // every result kept has its call kept too
      const kept = messages.slice(cut);
      const calls = new Set(
        kept.flatMap((m) =>
          m.role === "assistant"
            ? m.content.flatMap((b) => (b.type === "toolCall" ? [b.id] : []))
            : [],
        ),
      );
      for (const m of kept) if (m.role === "toolResult") expect(calls.has(m.toolCallId)).toBe(true);
    }
  });

  it("keeps the recent turns, roughly the asked amount", () => {
    const messages = thread();
    const cut = cutPoint(messages, 1, 450) as number;
    const kept = messages
      .slice(cut)
      .reduce((n, m) => n + Math.ceil(JSON.stringify(m).length / 4), 0);
    expect(messages.length - cut).toBeLessThanOrEqual(8);
    expect(messages.length - cut).toBeGreaterThanOrEqual(2);
    expect(kept).toBeGreaterThan(0);
  });

  it("returns undefined when nothing older than the cut would be summarized", () => {
    expect(cutPoint([system, user(5)], 1, 1000)).toBeUndefined();
    const messages = thread();
    expect(cutPoint(messages, messages.length - 1, 1)).toBeUndefined();
  });

  it("starts after the previous cut", () => {
    const messages = thread();
    const first = cutPoint(messages, 1, 300) as number;
    const second = cutPoint(messages, first, 100) as number;
    expect(second).toBeGreaterThan(first);
  });
});

describe("history with a compaction", () => {
  const compaction = { summary: "did things", keptFrom: 4, at: 8 };

  it("folds markers out and keeps every message", () => {
    const messages = thread().slice(0, 8);
    const rows = [...messages, { role: "compaction", ...compaction, timestamp: 1 }, user(3)];
    const folded = foldHistory(rows);
    expect(folded.messages).toEqual([...messages, user(3)]);
    expect(folded.compaction).toEqual(compaction);
  });

  it("the latest marker wins, and a history without one loads as before", () => {
    const later = { summary: "more", keptFrom: 6, at: 9 };
    const rows = [
      system,
      user(1),
      { role: "compaction", ...compaction },
      user(2),
      { role: "compaction", ...later },
    ];
    expect(foldHistory(rows).compaction).toEqual(later);
    expect(foldHistory([system, user(1)])).toEqual({ messages: [system, user(1)] });
  });

  it("a request is the system message, the summary and the kept messages", () => {
    const messages = thread();
    const view = compactedView(messages, { summary: "S", keptFrom: 6, at: messages.length });
    expect(view).toHaveLength(2 + messages.length - 6);
    expect(view[0]).toBe(system);
    expect((view[1] as { content: string }).content).toContain("<summary>\nS\n</summary>");
    expect(view.slice(2)).toEqual(messages.slice(6));
    expect(compactedView(messages)).toBe(messages);
  });

  it("does not trust a reply from before the compaction", () => {
    const stale = {
      ...(call("z", 1) as object),
      usage: { input: 300_000, output: 10, cacheRead: 0, cacheWrite: 0 },
    } as never;
    const messages = [system, user(1), stale, result("z", 1)];
    expect(inputTokens(messages)).toBeGreaterThan(300_000);
    expect(inputTokens(messages, { summary: "S", keptFrom: 2, at: 4 })).toBeLessThan(100);
  });
});
