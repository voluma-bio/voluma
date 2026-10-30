import { describe, expect, it } from "vitest";
import { transitiveDependents } from "./index";

// a → b → d, a → c → d, e alone.
const tasks = [
  { id: "a", dependsOn: [] },
  { id: "b", dependsOn: ["a"] },
  { id: "c", dependsOn: ["a"] },
  { id: "d", dependsOn: ["b", "c"] },
  { id: "e", dependsOn: [] },
];

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
