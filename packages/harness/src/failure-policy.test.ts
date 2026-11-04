import { describe, expect, it } from "vitest";
import { mainFailureAction } from "./failure-policy";

const failed = { status: "failed", error: "401" } as const;
const base = {
  kind: "fatal" as const,
  startedHere: false,
  replied: false,
  endBefore: undefined,
  previousFailed: true,
  failedBeforeRequest: false,
};

// A wrong answer here blocks every later correction of a run (a stale failure) or lets a failing main restart without bound.
describe("mainFailureAction", () => {
  it("fails a request whose replacement main failed too", () => {
    expect(mainFailureAction(base)).toBe("fail");
  });

  it("gives a new request a fresh main after an earlier request failed twice", () => {
    expect(mainFailureAction({ ...base, failedBeforeRequest: true })).toBe("replace");
    expect(
      mainFailureAction({
        ...base,
        kind: "interrupted",
        endBefore: { ...failed, interrupted: true },
        failedBeforeRequest: true,
      }),
    ).toBe("replace");
  });

  it("replaces a main that failed in this request once", () => {
    expect(mainFailureAction({ ...base, previousFailed: false })).toBe("replace");
  });
});
