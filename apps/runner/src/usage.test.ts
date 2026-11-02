import { describe, expect, it } from "vitest";
import { cacheBrokenError, usageMeter } from "./usage.ts";

const call = (input: number, cacheRead: number, cacheWrite = 0) => ({
  input,
  output: 10,
  cacheRead,
  cacheWrite,
  costUsd: 0.01,
});

describe("cache misses in a row", () => {
  it("counts misses per thread and resets on a hit", () => {
    const meter = usageMeter();
    expect(meter.addModelCall("main", "t1", call(1000, 0, 1000))).toBe(0); // first call: never a miss
    expect(meter.addModelCall("main", "t1", call(2000, 0))).toBe(1);
    expect(meter.addModelCall("main", "t1", call(2000, 0))).toBe(2);
    expect(meter.addModelCall("main", "t2", call(1000, 0, 1000))).toBe(0); // another thread
    expect(meter.addModelCall("main", "t1", call(0, 0))).toBe(2); // unreported: unchanged
    expect(meter.addModelCall("main", "t1", call(100, 1900))).toBe(0); // hit
  });

  it("fails at the limit, naming the run and thread", () => {
    expect(cacheBrokenError("r1", "t1", "main", 2, 3)).toBeUndefined();
    expect(cacheBrokenError("r1", "t1", "main", 3, 3)).toBe(
      "cache broken: thread t1 (main) of run r1 missed the prompt cache on 3 model calls in a row (RUNNER_CACHE_MISS_LIMIT=3)",
    );
  });
});
