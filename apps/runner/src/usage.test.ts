import { describe, expect, it } from "vitest";
import { type StopLimits, usageMeter } from "./usage.ts";

const limits = (over: Partial<StopLimits> = {}): StopLimits => ({
  runId: "r1",
  capUsd: 100,
  priorUsd: 0,
  cacheMissLimit: 3,
  ...over,
});
const call = (input: number, cacheRead: number, cacheWrite = 0, costUsd = 0.01) => ({
  input,
  output: 10,
  cacheRead,
  cacheWrite,
  costUsd,
});
const miss = call(2000, 0);

describe("usage meter stop check", () => {
  it("stops for budget once prior claims plus this one pass the cap", () => {
    const meter = usageMeter(limits({ capUsd: 10, priorUsd: 9 }));
    expect(meter.addModelCall("main", "t1", call(1000, 0, 0, 1))).toBeUndefined(); // at the cap
    expect(meter.addModelCall("main", "t1", call(1000, 0, 0, 0.5))?.kind).toBe("budget");
  });

  it("stops for cache after the limit of unexpected misses in a row on one thread", () => {
    const meter = usageMeter(limits());
    meter.addModelCall("main", "t1", call(1000, 0, 1000)); // first call: never a miss
    meter.addModelCall("main", "t2", call(1000, 0, 1000));
    expect(meter.addModelCall("main", "t1", miss)).toBeUndefined();
    expect(meter.addModelCall("main", "t2", miss)).toBeUndefined(); // other threads do not count
    expect(meter.addModelCall("main", "t1", call(0, 0))).toBeUndefined(); // unreported: no change
    expect(meter.addModelCall("main", "t1", miss)).toBeUndefined();
    const stop = meter.addModelCall("main", "t1", miss);
    expect(stop?.kind).toBe("cache");
    expect(stop?.message).toContain("t1");
  });

  it("does not count a hit, an expected miss, or the call after a compaction", () => {
    const meter = usageMeter(limits({ cacheMissLimit: 2 }));
    meter.addModelCall("main", "t1", call(1000, 0, 1000));
    meter.addModelCall("main", "t1", miss);
    meter.addModelCall("main", "t1", call(100, 1900)); // hit: resets
    meter.addModelCall("main", "t1", miss);
    meter.addMessage("t1", { role: "system", text: "Tools changed: added bash" });
    expect(meter.addModelCall("main", "t1", miss)).toBeUndefined(); // expected
    meter.addModelCall("main", "t1", miss);
    meter.addMessage("t1", { role: "assistant", text: "summary", compaction: true });
    expect(meter.addModelCall("main", "t1", miss)).toBeUndefined(); // new baseline
  });
});
