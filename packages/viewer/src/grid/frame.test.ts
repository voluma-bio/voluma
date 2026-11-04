/**
 * `spin`'s frame: a slip here mirrors a pane or drifts the planes off perpendicular, and a
 * resliced picture shows it only as a subtly wrong image.
 */
import { describe, expect, it } from "vitest";
import { cross, dot, GRID, type Orientation, offGrid, spin, tilt } from "./frame";

const close = (a: Orientation, b: Orientation) =>
  a.every((p, i) =>
    (["right", "down", "normal"] as const).every((k) =>
      p[k].every((v, j) => Math.abs(v - b[i]![k][j]!) < 1e-12),
    ),
  );

describe("spin", () => {
  const start = spin(tilt(GRID, 0, 0.3), 2, -0.7);
  it("keeps every pane orthonormal and a rotation of its grid pane", () => {
    const o = spin(spin(start, 1, 0.4), 0, 1.1);
    o.forEach((b, a) => {
      for (const v of [b.right, b.down, b.normal]) expect(dot(v, v)).toBeCloseTo(1, 12);
      expect(dot(b.right, b.down)).toBeCloseTo(0, 12);
      const g = GRID[a]!;
      // right × down against normal: the same sign as the grid pane's, so never mirrored.
      expect(dot(cross(b.right, b.down), b.normal)).toBeCloseTo(
        dot(cross(g.right, g.down), g.normal),
        12,
      );
    });
    expect(Math.abs(dot(o[0].normal, o[1].normal))).toBeLessThan(1e-12);
  });
  it("undoes itself and keeps the spun pane's plane", () => {
    for (const axis of [0, 1, 2] as const) {
      const o = spin(start, axis, 0.25);
      expect(o[axis].normal.every((v, j) => Math.abs(v - start[axis].normal[j]!) < 1e-12)).toBe(
        true,
      );
      expect(close(spin(o, axis, -0.25), start)).toBe(true);
    }
  });
  it("counts a pane spun in its own plane as turned", () => {
    expect(offGrid(spin(GRID, 1, (3.6 * Math.PI) / 180))).toBeCloseTo(3.6, 9);
  });
});
