/**
 * The ruler check: a line annotation's length, measured through its grid's affine, must equal
 * the length measurement that names it, so a ruler that disagrees with its number is refused
 * when the second of the pair is reported. Pure; the caller supplies the grid's affine.
 */

/** 4x4 row-major: voxel index (x, y, z) to world mm. */
type Affine = readonly (readonly number[])[];

const REL_TOLERANCE = 0.005;
const ABS_TOLERANCE_MM = 0.005;

/** A sentence naming both lengths when they differ by more than max(0.005 mm, 0.5 %); else undefined. */
export function rulerLengthProblem(
  line: { aZyx: readonly number[]; bZyx: readonly number[] },
  affine: Affine,
  measurement: { value: number; unit: string },
): string | undefined {
  if (measurement.unit !== "mm") {
    return `a ruler's length is checked in mm, but the measurement is in ${measurement.unit}`;
  }
  // The line is in voxel (z, y, x); the affine takes (x, y, z).
  const d = [2, 1, 0].map((i) => (line.bZyx[i] ?? 0) - (line.aZyx[i] ?? 0));
  const world = [0, 1, 2].map((r) => d.reduce((sum, di, c) => sum + (affine[r]?.[c] ?? 0) * di, 0));
  const length = Math.hypot(...world);
  const tolerance = Math.max(ABS_TOLERANCE_MM, REL_TOLERANCE * measurement.value);
  if (Math.abs(length - measurement.value) <= tolerance) return undefined;
  return `the ruler is ${length.toFixed(3)} mm long through its grid's affine, but the measurement says ${measurement.value.toFixed(3)} mm`;
}
