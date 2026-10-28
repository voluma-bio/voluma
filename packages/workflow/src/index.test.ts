import { describe, expect, it } from "vitest";
import { readyTasks, transitiveDependents } from "./index";

// a → b → d, a → c → d, e alone.
const tasks = [
  { id: "a", dependsOn: [] },
  { id: "b", dependsOn: ["a"] },
  { id: "c", dependsOn: ["a"] },
  { id: "d", dependsOn: ["b", "c"] },
  { id: "e", dependsOn: [] },
];

describe("readyTasks", () => {
  const status = (m: Record<string, string>) => (id: string) => m[id] ?? "pending";

  it("starts roots, then what their dependencies finished", () => {
    expect(readyTasks(tasks, status({}))).toEqual(["a", "e"]);
    expect(readyTasks(tasks, status({ a: "done", e: "in-progress" }))).toEqual(["b", "c"]);
  });

  it("waits for every dependency to be done, not just started or to check", () => {
    expect(readyTasks(tasks, status({ a: "done", b: "done", c: "to-check" }))).toEqual(["e"]);
  });

  it("restarts a stale task but not one in progress, under review or failed", () => {
    expect(readyTasks(tasks, status({ a: "stale", e: "under-review" }))).toEqual(["a"]);
    expect(readyTasks(tasks, status({ a: "failed", e: "failed" }))).toEqual([]);
  });

  it("does not restart a stale task whose dependency is stale too", () => {
    expect(readyTasks(tasks, status({ a: "stale", b: "stale", c: "done", e: "done" }))).toEqual([
      "a",
    ]);
  });
});

describe("transitiveDependents", () => {
  it("follows the graph through every path, in plan order", () => {
    expect(transitiveDependents(tasks, "a")).toEqual(["b", "c", "d"]);
    expect(transitiveDependents(tasks, "c")).toEqual(["d"]);
  });

  it("is empty for a leaf and for an unrelated task", () => {
    expect(transitiveDependents(tasks, "d")).toEqual([]);
    expect(transitiveDependents(tasks, "e")).toEqual([]);
  });

  it("finds dependents of a task listed after them", () => {
    const reordered = [tasks[3], tasks[1], tasks[0], tasks[2]] as typeof tasks;
    expect(transitiveDependents(reordered, "a")).toEqual(["d", "b", "c"]);
  });
});
