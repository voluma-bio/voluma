/**
 * `holdLevel`'s sharing: a slip here re-reads a whole level per pane, or keeps one after every
 * user has gone, and neither shows on screen.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { holdLevel } from "./planes";
import type { PlaneRequest, PlaneResponse } from "./zarr.worker";

// The worker the module starts: it records what was asked, and the test answers.
const posted: PlaneRequest[] = [];
let answer: (response: PlaneResponse) => void;
beforeAll(() => {
  vi.stubGlobal(
    "Worker",
    class {
      onmessage: ((event: { data: PlaneResponse }) => void) | null = null;
      onerror = null;
      constructor() {
        answer = (data) => this.onmessage?.({ data });
      }
      postMessage(request: PlaneRequest) {
        posted.push(request);
      }
      terminate() {}
    },
  );
});

const reads = (base: string) =>
  posted.filter((r) => "whole" in r && r.base === base) as { id: number }[];
const cancels = () => posted.flatMap((r) => ("cancel" in r ? [r.cancel] : []));
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("holdLevel", () => {
  it("keeps the level when it is held again within the microtask", async () => {
    const first = holdLevel("a/", "0");
    first.release();
    const again = holdLevel("a/", "0");
    await tick();
    expect(reads("a/")).toHaveLength(1);
    expect(again.read).toBe(first.read);
    expect(cancels()).not.toContain(reads("a/")[0]!.id);
    again.release();
  });

  it("cancels the read and drops the level on the last release", async () => {
    const one = holdLevel("b/", "0");
    const two = holdLevel("b/", "0");
    void one.read.catch(() => {});
    one.release();
    await tick();
    const [read] = reads("b/");
    expect(cancels()).not.toContain(read!.id);
    two.release();
    await tick();
    expect(cancels()).toContain(read!.id);
    await expect(one.read).rejects.toBeDefined();
    holdLevel("b/", "0").release();
    expect(reads("b/")).toHaveLength(2);
  });

  it("doesn't keep a failed read", async () => {
    const held = holdLevel("c/", "0");
    answer({ id: reads("c/")[0]!.id, error: "no such level" });
    await expect(held.read).rejects.toThrow("no such level");
    const retry = holdLevel("c/", "0");
    expect(reads("c/")).toHaveLength(2);
    expect(retry.read).not.toBe(held.read);
    void retry.read.catch(() => {});
    held.release();
    retry.release();
  });
});
