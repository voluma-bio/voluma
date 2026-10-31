/**
 * A run whose plan predates a unit change in `outputs.json` reports in the old unit, which would
 * plot and flag silently wrong (210 µm drawn as 210 mm): it must stay out of the values, the far
 * rule and the plot.
 */
import type { StudyDetail, StudyScanDetail } from "@voluma/contracts/study";
import type { OutputEntry } from "@voluma/contracts/workflow-files";
import { describe, expect, it } from "vitest";
import { farFromGroup, otherUnit, scanValue, valuesOf } from "./study-model";

const ctTh = { id: "ct_th", kind: "measurement", unit: "mm" } as OutputEntry;

const scan = (inputId: string, value: number, unit: string) =>
  ({
    scan: { inputId, subject: inputId, group: "DMM", attributes: {} },
    runs: [],
    resultRunId: `run-${inputId}`,
    values: { ct_th: { value, unit, confidence: null } },
    toCheck: [],
  }) as unknown as StudyScanDetail;

const detail = {
  study: {},
  scans: [scan("a", 0.21, "mm"), scan("b", 0.2, "mm"), scan("c", 0.22, "mm"), scan("d", 210, "µm")],
} as unknown as StudyDetail;

describe("a value in another unit", () => {
  it("has no value in the declared unit and names its own", () => {
    const d = detail.scans[3] as StudyScanDetail;
    expect(scanValue(d, ctTh)).toBeNull();
    expect(otherUnit(d, ctTh)).toBe("µm");
    expect(otherUnit(detail.scans[0] as StudyScanDetail, ctTh)).toBeNull();
  });

  it("stays out of the values and the far-from-group rule", () => {
    expect(valuesOf(detail, ctTh)).toEqual([0.21, 0.2, 0.22]);
    expect(farFromGroup(detail, ctTh).size).toBe(0);
  });
});
