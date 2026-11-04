/**
 * A grid's affine (voxel index (x, y, z) to world mm, 4x4 row-major, orthogonal columns): points
 * and directions between voxels and world mm, the one place this maths lives. And the ruler
 * check: a line annotation's length must equal the length measurement that names it, so a ruler
 * that disagrees with its number is refused when the second of the pair is reported. Pure; the
 * caller supplies the lengths.
 */

import type { Volume } from "./review";

type Vec3 = [number, number, number];

const REL_TOLERANCE = 0.005;
const ABS_TOLERANCE_MM = 0.005;

/** A grid voxel `[z, y, x]` in world mm through the grid's affine (voxel index (x, y, z) to world). */
export const toWorld = (
  m: Volume["affine"],
  [z, y, x]: readonly [number, number, number],
): [number, number, number] => {
  const row = (r: Volume["affine"][number]) => r[0] * x + r[1] * y + r[2] * z + r[3];
  return [row(m[0]), row(m[1]), row(m[2])];
};

/** The affine in an output's `detail` (written by the harness), else undefined. */
export const affineIn = (detail: unknown): Volume["affine"] | undefined => {
  const a = (detail as { affine?: unknown } | null | undefined)?.affine;
  return Array.isArray(a) &&
    a.length === 4 &&
    a.every((r) => Array.isArray(r) && r.length === 4 && r.every(Number.isFinite))
    ? (a as Volume["affine"])
    : undefined;
};

/** Every voxel `(x, y, z)` of a flat list of triples in world mm, as a flat list of triples. */
export function xyzToWorld(m: Volume["affine"], xyz: ArrayLike<number>): Float64Array {
  const world = new Float64Array(xyz.length);
  for (let i = 0; i + 2 < xyz.length; i += 3)
    for (let r = 0; r < 3; r++) {
      const row = m[r]!;
      world[i + r] = row[0] * xyz[i]! + row[1] * xyz[i + 1]! + row[2] * xyz[i + 2]! + row[3];
    }
  return world;
}

/** The grid's x, y and z axes as world unit vectors (the affine's columns, normalized). */
export const axesOf = (m: Volume["affine"]): [Vec3, Vec3, Vec3] => {
  const axis = (j: 0 | 1 | 2): Vec3 => {
    const n = Math.hypot(m[0][j], m[1][j], m[2][j]);
    return [m[0][j] / n, m[1][j] / n, m[2][j] / n];
  };
  return [axis(0), axis(1), axis(2)];
};

/** A world direction in the grid's mm, (z, y, x): its components along the grid's axes. */
export function directionInGrid(
  m: Volume["affine"],
  world: readonly [number, number, number],
): Vec3 {
  const [x, y, z] = axesOf(m);
  const along = (a: Vec3) => a[0] * world[0] + a[1] * world[1] + a[2] * world[2];
  return [along(z), along(y), along(x)];
}

/** Distance in mm between two world points. */
export const distanceMm = (
  [ax, ay, az]: readonly [number, number, number],
  [bx, by, bz]: readonly [number, number, number],
) => Math.hypot(ax - bx, ay - by, az - bz);

/** A sentence naming both lengths when they differ by more than max(0.005 mm, 0.5 %); else undefined. */
export function rulerLengthProblem(
  lengthMm: number,
  measurement: { value: number; unit: string },
): string | undefined {
  if (measurement.unit !== "mm") {
    return `a ruler's length is checked in mm, but the measurement is in ${measurement.unit}`;
  }
  const tolerance = Math.max(ABS_TOLERANCE_MM, REL_TOLERANCE * measurement.value);
  if (Math.abs(lengthMm - measurement.value) <= tolerance) return undefined;
  return `the ruler is ${lengthMm.toFixed(3)} mm long, but the measurement says ${measurement.value.toFixed(3)} mm`;
}
