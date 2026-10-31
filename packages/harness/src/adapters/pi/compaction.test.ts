import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import {
  compactedView,
  compactionRow,
  compactionThresholds,
  compactor,
  cutPoint,
  foldHistory,
  imageLoad,
  inputTokens,
  readRow,
} from "./compaction";

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
      const cut = cutPoint(messages, 1, { tokens: keep });
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
    const cut = cutPoint(messages, 1, { tokens: 450 }) as number;
    const kept = messages
      .slice(cut)
      .reduce((n, m) => n + Math.ceil(JSON.stringify(m).length / 4), 0);
    expect(messages.length - cut).toBeLessThanOrEqual(8);
    expect(messages.length - cut).toBeGreaterThanOrEqual(2);
    expect(kept).toBeGreaterThan(0);
  });

  it("returns undefined when nothing older than the cut would be summarized", () => {
    expect(cutPoint([system, user(5)], 1, { tokens: 1000 })).toBeUndefined();
    const messages = thread();
    expect(cutPoint(messages, messages.length - 1, { tokens: 1 })).toBeUndefined();
  });

  it("starts after the previous cut", () => {
    const messages = thread();
    const first = cutPoint(messages, 1, { tokens: 300 }) as number;
    const second = cutPoint(messages, first, { tokens: 100 }) as number;
    expect(second).toBeGreaterThan(first);
  });
});

describe("history with a compaction", () => {
  const compaction = { summary: "did things", keptFrom: 4 };
  const rows = (...items: unknown[]) => items.map((m) => JSON.stringify(m));
  const marker = (c: { summary: string; keptFrom: number }) => ({ role: "compaction", ...c });

  it("folds markers out, keeps every message and derives where the marker sat", () => {
    const messages = thread().slice(0, 8);
    const folded = foldHistory(rows(...messages, marker(compaction), user(3)));
    expect(folded.messages).toEqual([...messages, user(3)]);
    expect(folded.compaction).toEqual({ ...compaction, at: 8 });
  });

  it("the latest marker wins, and a history without one loads as before", () => {
    const later = { summary: "more", keptFrom: 6 };
    const folded = foldHistory(rows(system, user(1), marker(compaction), user(2), marker(later)));
    expect(folded.compaction).toEqual({ ...later, at: 3 });
    expect(foldHistory(rows(system, user(1)))).toEqual({ messages: [system, user(1)] });
  });

  it("a message that mentions a marker is not one", () => {
    const quoting = user(1);
    (quoting as { content: string }).content = '{"role":"compaction","summary":"x","keptFrom":1}';
    expect(readRow(JSON.stringify(quoting)).kind).toBe("message");
    expect(readRow(compactionRow({ ...compaction, at: 9 }))).toEqual({
      kind: "marker",
      marker: compaction,
    });
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
    expect(inputTokens(messages)).toBe(300_000);
    expect(inputTokens(messages, { summary: "S", keptFrom: 2, at: 4 })).toBeLessThan(100);
  });
});

describe("thresholds", () => {
  const model = (contextWindow: number, maxTokens = 131_072) =>
    ({ contextWindow, maxTokens }) as never;
  it("budget is min(400k, window); compact one output reserve below it, warn half a reserve below that", () => {
    expect(compactionThresholds(model(1_000_000))).toMatchObject({
      warn: 304_000,
      compact: 336_000,
    });
    expect(compactionThresholds(model(200_000, 64_000))).toMatchObject({
      warn: 104_000,
      compact: 136_000,
    });
    // a 32k-output model reserves only 32k
    expect(compactionThresholds(model(1_000_000, 32_000))).toMatchObject({
      warn: 352_000,
      compact: 368_000,
    });
    expect(compactionThresholds(model(32_000, 8_000)).compact).toBeGreaterThan(0);
  });
});

// The compactor with a scripted model: each call returns the next reply and records its request.
describe("compactor", () => {
  const image = (bytes: number): AgentMessage =>
    ({
      role: "toolResult",
      toolCallId: "i",
      toolName: "view_image",
      content: [{ type: "image", mimeType: "image/png", data: "A".repeat(bytes) }],
    }) as never;
  const reply = (text: string, stopReason = "stop", extra: object = {}) => ({
    stopReason,
    content: [{ type: "text", text }],
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.5 },
    },
    ...extra,
  });
  type Reply = ReturnType<typeof reply>;

  function setup(replies: Reply[], model: object = { contextWindow: 200_000, maxTokens: 32_000 }) {
    const requests: { messages: AgentMessage[]; maxTokens: number }[] = [];
    const stored: string[] = [];
    const summaries: string[] = [];
    const usages: unknown[] = [];
    const c = compactor({
      threadId: "t",
      model: model as never,
      streamFn: (async (
        _m: unknown,
        ctx: { messages: AgentMessage[] },
        o: { maxTokens: number },
      ) => {
        requests.push({ messages: ctx.messages, maxTokens: o.maxTokens });
        const next = replies.shift();
        return { result: async () => next };
      }) as never,
      store: async (row) => {
        stored.push(row);
        return true;
      },
      onSummary: (r, summary) => {
        summaries.push(summary);
        usages.push(r.usage);
      },
    });
    return { c, requests, stored, summaries, usages };
  }
  // The last reply reports `input` tokens.
  const thread_ = (input: number) => {
    const messages = thread();
    (messages[messages.length - 2] as { usage?: unknown }).usage = {
      input,
      output: 10,
      cacheRead: 0,
      cacheWrite: 0,
    };
    return messages;
  };

  it("warm: notice once, then at the first request past the compact point the same messages plus the instruction, one marker, one recorded reply", async () => {
    const { c, requests, stored, summaries } = setup([reply("SUM")], {
      contextWindow: 1_000_000,
      maxTokens: 131_072,
    });
    expect(c.contextNotice(thread_(300_000))).toBeUndefined();
    const warnAt = thread_(310_000);
    expect(c.contextNotice(warnAt)).toContain("nearly full");
    expect(c.contextNotice(warnAt)).toBeUndefined(); // once per context-full event
    await c.prepare(warnAt);
    expect(requests).toHaveLength(0);
    const messages = thread_(340_000);
    const view = await c.prepare(messages);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.messages.slice(0, messages.length)).toEqual(messages);
    expect(stored).toHaveLength(1);
    expect(summaries).toEqual(["SUM"]);
    expect(view.length).toBeLessThan(messages.length);
  });

  it("cold when the images near the request limit: no kept tail, no images", async () => {
    const { c, requests } = setup([reply("SUM")], {
      contextWindow: 1_000_000,
      maxTokens: 32_000,
      inputLimits: { maxRequestBytes: 1_000 },
    });
    const messages = thread_(150_000);
    messages.splice(4, 0, image(950));
    await c.prepare(messages);
    const sent = requests[0]?.messages ?? [];
    expect(sent.length).toBeLessThan(messages.length);
    expect(JSON.stringify(sent)).not.toContain("AAAAAAAAAA");
    expect(sent[0]).toBe(messages[0]);
  });

  it("recover summarizes cold without the tail and stores the marker", async () => {
    const { c, requests, stored } = setup([reply("SUM")]);
    const messages = thread_(150_000);
    expect(await c.recover(messages)).toBe(true);
    expect(requests[0]?.messages.length).toBeLessThan(messages.length);
    expect(JSON.parse(stored[0] as string)).toMatchObject({ role: "compaction", summary: "SUM" });
  });

  it("recover stores nothing and answers false when the summary fails", async () => {
    const { c, stored } = setup([reply("", "error", { errorMessage: "prompt is too long" })]);
    expect(await c.recover(thread_(150_000))).toBe(false);
    expect(stored).toHaveLength(0);
  });

  it("accepts a summary that also called a tool, and retries once on length", async () => {
    const a = setup([reply("SUM", "toolUse")]);
    expect(await a.c.recover(thread_(150_000))).toBe(true);
    const b = setup([reply("cut", "length"), reply("FULL")]);
    expect(await b.c.recover(thread_(150_000))).toBe(true);
    expect(b.requests.map((r) => r.maxTokens)).toEqual([16_000, 32_000]);
    expect(b.summaries).toEqual(["FULL"]);
    // both calls were billed
    expect(b.usages).toEqual([expect.objectContaining({ input: 2, output: 2 })]);
    expect((b.usages[0] as { cost: { total: number } }).cost.total).toBe(1);
  });

  it("many small images: one compaction, not one per turn", async () => {
    const turn = (i: number): AgentMessage[] => [
      call(`i${i}`, 1000),
      {
        role: "toolResult",
        toolCallId: `i${i}`,
        toolName: "view_image",
        content: Array.from({ length: 4 }, () => ({
          type: "image",
          mimeType: "image/png",
          data: "A".repeat(100),
        })),
      } as never,
    ];
    const { c, requests } = setup(
      Array.from({ length: 30 }, () => reply("SUM")),
      { contextWindow: 1_000_000, maxTokens: 32_000 },
    );
    const messages = [system, user(10), ...Array.from({ length: 20 }, (_, i) => turn(i)).flat()];
    await c.prepare(messages);
    for (let i = 20; i < 23; i++) {
      messages.push(...turn(i));
      await c.prepare(messages);
    }
    expect(requests).toHaveLength(1);
  });

  it("the provider's error text reaches the caller unchanged", async () => {
    const { c } = setup([reply("", "error", { errorMessage: "529 overloaded" })], {
      contextWindow: 1_000_000,
      maxTokens: 32_000,
    });
    await expect(c.prepare(thread_(900_000))).rejects.toThrow(/^529 overloaded$/);
  });

  it("images near the request limit make a thread due, and compact at once when tight", async () => {
    const model = {
      contextWindow: 1_000_000,
      maxTokens: 32_000,
      inputLimits: { maxRequestBytes: 1_000 },
    };
    const { c, requests } = setup([reply("SUM")], model);
    const due = [...thread(), image(450)];
    expect(imageLoad(due).bytes).toBe(450);
    expect(c.contextNotice(due)).toContain("nearly full"); // 45% of the limit: due, not tight
    const tight = [...thread(), image(800)];
    await c.prepare(tight); // 80%: another turn might not fit
    expect(requests).toHaveLength(1);
  });

  it("skips the notice when another turn would not fit", () => {
    const { c } = setup([]);
    expect(c.contextNotice(thread_(180_000))).toBeUndefined();
  });
});
