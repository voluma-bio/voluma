import { describe, expect, it } from "vitest";
import { FileNotFound, type Files } from "../../ports/files";
import type { History } from "../../ports/history";
import { withImageRefs } from "./image-refs";

function world() {
  const objects = new Map<string, Buffer>();
  const reads: string[] = [];
  const files: Files = {
    async *read(key) {
      reads.push(key);
      const b = objects.get(key);
      if (!b) throw new FileNotFound(key);
      yield b;
    },
    async write(key, bytes) {
      objects.set(key, Buffer.from(bytes));
    },
    async list() {
      return [];
    },
  };
  const rows: string[] = [];
  const history: History = {
    load: async () => rows,
    appendMessage: async (_t, _i, m) => {
      rows.push(m);
    },
  };
  return { objects, reads, rows, wrapped: withImageRefs(history, files, "r1") };
}

const result = (n: number, data = "AAAA") =>
  JSON.stringify({
    role: "toolResult",
    content: [
      { type: "text", text: "Showing" },
      ...Array.from({ length: n }, () => ({ type: "image", mimeType: "image/png", data })),
    ],
  });

describe("withImageRefs", () => {
  it("stores references and gives the images back", async () => {
    const w = world();
    await w.wrapped.appendMessage("r1.t1.worker", 0, result(2));
    expect(w.rows[0]).toContain('"imageRef"');
    expect(w.rows[0]).not.toContain("AAAA");
    const [back] = await w.wrapped.load("r1.t1.worker");
    expect(
      JSON.parse(back as string).content.filter((c: { type: string }) => c.type === "image"),
    ).toHaveLength(2);
  });

  it("loads a row written with inline images unchanged", async () => {
    const w = world();
    w.rows.push(result(1));
    expect(await w.wrapped.load("r1.t1.worker")).toEqual([result(1)]);
  });

  it("turns a missing object or a changed one into a note", async () => {
    const w = world();
    await w.wrapped.appendMessage("r1.t1.worker", 0, result(1, "AAAA"));
    await w.wrapped.appendMessage("r1.t1.worker", 1, result(1, "BBBB"));
    const [a, b] = [...w.objects.keys()];
    w.objects.delete(a as string);
    w.objects.set(b as string, Buffer.from("tampered"));
    const loaded = (await w.wrapped.load("r1.t1.worker")).map((r) => JSON.parse(r).content[1].text);
    expect(loaded[0]).toMatch(/not available: its file was deleted/);
    expect(loaded[1]).toMatch(/not available: its file changed/);
  });

  it("fetches only the images since the latest compaction", async () => {
    const w = world();
    const marker = JSON.stringify({ role: "compaction", summary: "s", keptFrom: 2, at: 4 });
    for (const [i, row] of [result(1, "AAAA"), result(1, "BBBB"), result(1, "CCCC")].entries()) {
      await w.wrapped.appendMessage("r1.t1.worker", i, row);
    }
    await w.wrapped.appendMessage("r1.t1.worker", 3, marker);
    w.reads.length = 0;
    const loaded = (await w.wrapped.load("r1.t1.worker")).map((r) => JSON.parse(r));
    expect(w.reads).toHaveLength(1);
    expect(loaded[0].content[1].text).toMatch(/no longer shown/);
    expect(loaded[1].content[1].text).toMatch(/no longer shown/);
    expect(loaded[2].content[1].type).toBe("image");
    expect(loaded[3].role).toBe("compaction");
  });
});
