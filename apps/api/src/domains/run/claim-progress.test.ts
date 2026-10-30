import { describe, expect, it } from "vitest";
import { endClaim, isProgress, outageDelayMinutes, stalledError } from "./claim-progress";

const run = (over: Partial<Parameters<typeof endClaim>[0]> = {}) => ({
  lastProgressSeq: 5,
  claimStartSeq: 5,
  stalledClaims: 0,
  ...over,
});

describe("endClaim", () => {
  it("counts a self-stop or expired lease that made no progress", () => {
    expect(endClaim(run(), "self-stop").stalledClaims).toBe(1);
    expect(endClaim(run({ stalledClaims: 1 }), "lease-expired").stalledClaims).toBe(2);
  });

  it("never counts a shutdown, and keeps the count", () => {
    expect(endClaim(run({ stalledClaims: 2 }), "shutdown")).toEqual({
      stalledClaims: 2,
      exhausted: false,
    });
  });

  it("resets on progress since the claim began, whatever the reason", () => {
    const progressed = run({ lastProgressSeq: 9, stalledClaims: 2 });
    expect(endClaim(progressed, "self-stop").stalledClaims).toBe(0);
    expect(endClaim(progressed, "lease-expired").stalledClaims).toBe(0);
  });

  it("fails the run on the third counted claim", () => {
    expect(endClaim(run({ stalledClaims: 2 }), "lease-expired").exhausted).toBe(true);
    expect(endClaim(run({ stalledClaims: 1 }), "lease-expired").exhausted).toBe(false);
  });
});

describe("provider-outage", () => {
  it("counts like a stall, and the wait grows 1, 2 minutes with the count", () => {
    expect(endClaim(run(), "provider-outage").stalledClaims).toBe(1);
    expect(endClaim(run({ stalledClaims: 2 }), "provider-outage").exhausted).toBe(true);
    expect([0, 1, 2].map(outageDelayMinutes)).toEqual([1, 1, 2]);
  });

  it("starts again at one minute after progress", () => {
    const progressed = run({ lastProgressSeq: 9, stalledClaims: 2 });
    const { stalledClaims } = endClaim(progressed, "provider-outage");
    expect(stalledClaims).toBe(0);
    expect(outageDelayMinutes(stalledClaims)).toBe(1);
  });
});

describe("stalledError", () => {
  it("names the call that was in flight", () => {
    expect(stalledError("lease-expired", "segment_sam")).toBe(
      "Stopped: the server lost contact with the runner 3 times in a row without progress (last call: `segment_sam`).",
    );
    expect(stalledError("self-stop", undefined)).not.toContain("last call");
  });
});

describe("isProgress", () => {
  it("counts run-state changes, not model turns, tool calls or the first plan", () => {
    expect(isProgress({ type: "task", payload: {} })).toBe(true);
    expect(isProgress({ type: "revision.started", payload: { reason: "correction" } })).toBe(true);
    expect(isProgress({ type: "revision.started", payload: { reason: "run" } })).toBe(false);
    expect(isProgress({ type: "tool.call", payload: {} })).toBe(false);
    expect(isProgress({ type: "message", payload: {} })).toBe(false);
  });
});
