import { describe, expect, it } from "vitest";
import { costCapError } from "./usage.ts";

describe("costCapError", () => {
  it("is undefined up to and at the cap", () => {
    expect(costCapError("r1", 0, 50)).toBeUndefined();
    expect(costCapError("r1", 50, 50)).toBeUndefined();
  });

  it("names the run, the spend and the cap once spend passes it", () => {
    expect(costCapError("r1", 50.004, 50)).toBe(
      "budget exceeded: run r1 spent $50.00 on model calls, over its $50 cap (RUNNER_MAX_RUN_COST_USD)",
    );
  });
});
