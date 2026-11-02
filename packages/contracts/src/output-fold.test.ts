import { describe, expect, it } from "vitest";
import type { RunEvent } from "./events";
import type { OutputEntry } from "./output-catalog";
import {
  applyOutputsChange,
  finalOutputs,
  latest,
  outputsFold,
  pendingFinal,
  undecidedOutOfDate,
} from "./output-fold";

type Link = { id: string; version: number; role: "on" | "base" | "input" };
const sha = (n: string) => n.padEnd(64, "0");

/** A log under construction, one method per event the fold reads. */
function run() {
  const events: RunEvent[] = [];
  const push = (type: string, payload: unknown, threadId = "t-main") =>
    events.push({
      id: `e${events.length}`,
      runId: "r",
      threadId,
      createdAt: new Date(Date.UTC(2026, 10, 1, 0, 0, events.length)).toISOString(),
      seq: events.length + 1,
      type,
      payload,
    } as RunEvent);
  const publish = (
    id: string,
    version: number,
    files: Record<string, string>,
    madeFrom: Link[] = [],
    extra: object = {},
  ) =>
    push("output", {
      outputId: id,
      title: id,
      evidence: [],
      output: {
        kind: "file",
        file: { root: "outputs", path: `${id}/c${version}/x`, sha256: sha("a") },
        mediaType: "application/octet-stream",
      },
      version,
      path: `${id}/c${version}`,
      files: Object.entries(files).map(([path, h]) => ({ path, sha256: sha(h) })),
      madeFrom,
      kind: "overlay",
      ...extra,
    });
  const final = (...entries: OutputEntry[]) =>
    push("outputs.changed", { by: "runner", reason: "start", add: entries });
  return { events, push, publish, final };
}

const overlay = (id: string): OutputEntry => ({ kind: "overlay", id, name: id, base: "scan" });
const scan: OutputEntry = { kind: "base", id: "scan", name: "scan" };

/** scan <- labels <- grid <- roi <- value, all at version 1; only `value` is final. */
function chain() {
  const r = run();
  r.push("thread.started", { name: "seg" }, "t-seg");
  r.final(scan, overlay("labels"), overlay("grid"), overlay("roi"), {
    kind: "value",
    id: "bv",
    name: "bv",
    unit: "%",
    on: ["roi"],
  });
  r.publish("labels", 1, { "l.npy": "a1" });
  r.publish("grid", 1, { "g.npy": "b1" }, [{ id: "labels", version: 1, role: "input" }]);
  r.publish("roi", 1, { "r.npy": "c1" }, [{ id: "grid", version: 1, role: "base" }]);
  r.publish("bv", 1, {}, [{ id: "roi", version: 1, role: "on" }], {
    kind: "value",
    output: {
      kind: "measurement",
      value: 12,
      unit: "%",
      id: "bv",
      confidence: null,
      evidenceIds: [],
      references: [],
      on: [],
      context: [],
      source: null,
    },
  });
  return r;
}

const stale = (events: RunEvent[]) =>
  outputsFold(events)
    .outputs.filter((o) => o.outOfDate)
    .map((o) => o.id);

describe("out of date", () => {
  it("is clean while every link names the latest version", () => {
    expect(stale(chain().events)).toEqual([]);
  });

  it("is transitive: a changed input makes everything made from it out of date", () => {
    const r = chain();
    r.publish("labels", 2, { "l.npy": "a2" });
    expect(stale(r.events)).toEqual(["grid", "roi", "bv"]);
  });

  it("ignores a redo whose files hash the same", () => {
    const r = chain();
    r.publish("labels", 2, { "l.npy": "a1" });
    expect(stale(r.events)).toEqual([]);
  });

  it("counts a change to a file that is not the primary one", () => {
    const r = chain();
    r.publish("labels", 2, { "l.npy": "a1", "l.json": "z" });
    expect(stale(r.events)).toEqual(["grid", "roi", "bv"]);
  });

  it("is cleared by a keep, which holds the same files on the latest inputs", () => {
    const r = chain();
    r.publish("labels", 2, { "l.npy": "a2" });
    r.publish("grid", 2, { "g.npy": "b1" }, [{ id: "labels", version: 2, role: "input" }], {
      kept: { reason: "only a corner changed" },
    });
    expect(stale(r.events)).toEqual([]);
  });

  it("returns when a later input version arrives after a keep", () => {
    const r = chain();
    r.publish("labels", 2, { "l.npy": "a2" });
    r.publish("grid", 2, { "g.npy": "b1" }, [{ id: "labels", version: 2, role: "input" }]);
    r.publish("labels", 3, { "l.npy": "a3" });
    expect(stale(r.events)).toEqual(["grid", "roi", "bv"]);
  });

  it("does not hold a version against its own earlier one", () => {
    const r = chain();
    r.publish("roi", 2, { "r.npy": "c2" }, [
      { id: "roi", version: 1, role: "input" },
      { id: "grid", version: 1, role: "base" },
    ]);
    expect(stale(r.events)).toEqual(["bv"]);
  });

  it("blocks close only for outputs in a final output's trail", () => {
    const r = chain();
    r.publish("side", 1, { "s.npy": "s1" }, [{ id: "labels", version: 1, role: "input" }]);
    r.publish("labels", 2, { "l.npy": "a2" });
    expect(stale(r.events)).toEqual(["grid", "roi", "bv", "side"]);
    expect(undecidedOutOfDate(r.events)).toEqual(["grid", "roi", "bv"]);
  });
});

describe("status", () => {
  it("runs pending, reported, to check, out of date and missing", () => {
    const r = run();
    r.final(scan, overlay("a"), overlay("b"));
    expect(pendingFinal(r.events)).toEqual(["scan", "a", "b"]);
    r.push("outputs.changed", {
      by: "main",
      reason: "no scan field",
      missing: [{ id: "b", reason: "not in the field" }],
    });
    expect(pendingFinal(r.events)).toEqual(["scan", "a"]);
    r.publish("scan", 1, { "s.npy": "1" });
    r.publish("a", 1, { "a.npy": "2" }, [{ id: "scan", version: 1, role: "base" }], {
      toCheck: [{ title: "edge" }, { title: "top" }],
    });
    const status = () => finalOutputs(r.events).map((o) => o.status);
    expect(status()).toEqual(["reported", "to-check", "missing"]);
    r.push("tocheck.resolved", { output: "a", version: 1, item: 0, by: "u", outcome: "accepted" });
    expect(status()[1]).toBe("to-check");
    r.push("tocheck.resolved", { output: "a", version: 1, item: 1, by: "u", outcome: "corrected" });
    expect(status()[1]).toBe("reported");
    r.publish("scan", 2, { "s.npy": "3" });
    expect(status()).toEqual(["reported", "out-of-date", "missing"]);
  });

  it("gives the latest version and who made it", () => {
    const r = chain();
    expect(latest(r.events, "labels")).toMatchObject({ version: 1, by: "t-main" });
    expect(latest(r.events, "nope")).toBeUndefined();
  });

  it("keeps the first of two events claiming one version", () => {
    const r = chain();
    r.publish("labels", 1, { "l.npy": "other" });
    expect(latest(r.events, "labels")?.files[0]?.sha256).toBe(sha("a1"));
  });
});

describe("applyOutputsChange", () => {
  const at = "2026-11-01T00:00:00.000Z";
  const start = applyOutputsChange(
    undefined,
    { by: "runner", reason: "start", add: [scan, overlay("a")] },
    at,
  );
  if (!("list" in start)) throw new Error("setup");

  it("groups what no section names", () => {
    expect(start.list.sections.map((s) => s.title)).toEqual(["Other"]);
  });
  it("refuses a drop that leaves a link dangling", () => {
    const r = applyOutputsChange(start.list, { by: "main", reason: "x", drop: ["scan"] }, at);
    expect(r).toMatchObject({ refusal: expect.stringContaining("scan") });
  });
  it("refuses unknown ids and repeats", () => {
    expect(
      applyOutputsChange(start.list, { by: "main", reason: "x", drop: ["zz"] }, at),
    ).toHaveProperty("refusal");
    expect(
      applyOutputsChange(start.list, { by: "main", reason: "x", add: [scan] }, at),
    ).toHaveProperty("refusal");
  });
  it("regroups into sections and appends expect lines", () => {
    const r = applyOutputsChange(
      start.list,
      {
        by: "main",
        reason: "x",
        sections: [{ title: "Bones", outputs: ["scan", "a"] }],
        expect: [{ id: "a", lines: ["smooth"] }],
      },
      at,
    );
    if (!("list" in r)) throw new Error(JSON.stringify(r));
    expect(r.list.sections.map((s) => s.title)).toEqual(["Bones"]);
    expect(r.list.sections[0]?.outputs[1]).toMatchObject({ expect: ["smooth"] });
  });
});
