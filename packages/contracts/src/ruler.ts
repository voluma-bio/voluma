/**
 * Voxel to world mm, and the ruler check: a line annotation's length must equal the length
 * measurement that names it, so a ruler that disagrees with its number is refused when the
 * second of the pair is reported. Pure; the caller supplies the lengths.
 */

import type { Volume } from "./review";

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

/** Distance in mm between two world points. */
export const distanceMm = (a: readonly number[], b: readonly number[]) =>
  Math.hypot(...a.map((v, i) => v - (b[i] ?? 0)));

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
