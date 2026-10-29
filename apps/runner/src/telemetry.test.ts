import { expect, test } from "vitest";
import { inFlightCalls, inRunScope } from "./telemetry.ts";

// A tool call that never resulted must not outlive its run in later loop-block lines.
test("a run's in-flight calls end with the run", async () => {
  const scope = { runId: "r1", log() {}, inFlight: new Map([["c1", "intake.worker bash"]]) };
  await inRunScope(scope, async () => {
    expect(inFlightCalls()).toEqual(["r1 intake.worker bash"]);
  });
  expect(inFlightCalls()).toEqual([]);
});
