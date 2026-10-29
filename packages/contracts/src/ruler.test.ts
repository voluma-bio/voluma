import { describe, expect, it } from "vitest";
import { rulerLengthProblem } from "./ruler";

// Anisotropic: 0.02 mm in x, 0.03 mm in y, 0.05 mm in z.
const affine = [
  [0.02, 0, 0, 1],
  [0, 0.03, 0, 2],
  [0, 0, 0.05, 3],
  [0, 0, 0, 1],
];
// 100 voxels in x, 40 in y, 20 in z: (2, 1.2, 1) mm.
const line = { aZyx: [10, 20, 30], bZyx: [30, 60, 130] };
const mm = Math.hypot(2, 1.2, 1);

describe("rulerLengthProblem", () => {
  it("accepts the length through the affine, not the voxel count", () => {
    expect(rulerLengthProblem(line, affine, { value: mm, unit: "mm" })).toBeUndefined();
    expect(rulerLengthProblem(line, affine, { value: mm * 1.004, unit: "mm" })).toBeUndefined();
  });
  it("refuses a different length, naming both", () => {
    expect(rulerLengthProblem(line, affine, { value: mm * 1.01, unit: "mm" })).toMatch(
      /2\.538 mm.*2\.563 mm/,
    );
  });
  it("refuses a non-mm unit", () => {
    expect(rulerLengthProblem(line, affine, { value: mm, unit: "voxels" })).toMatch(/voxels/);
  });
});
