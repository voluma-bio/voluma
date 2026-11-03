/**
 * How a slice stack sits in a volume. Slices are taken along `axis`; a slice's rows run along the
 * lower of the other two axes and its columns along the higher. Every function here reads or
 * writes volume-ordered (z-major) data through strides, so no reordered copy is ever made.
 */
import type { Prompt } from "./input";
import type { Vec3 } from "./npy";

export type Axis = 0 | 1 | 2;

export const sliceAxes = (axis: Axis): [Axis, Axis] =>
  axis === 0 ? [1, 2] : axis === 1 ? [0, 2] : [0, 1];

export const stridesOf = (dims: Vec3): Vec3 => [dims[1] * dims[2], dims[2], 1];

export const dimsOf = (lo: Vec3, hi: Vec3): Vec3 => [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];

/** A box of the volume, ends exclusive. */
export interface Box {
  lo: Vec3;
  hi: Vec3;
}

/** The volume box that holds a prompt's box and points, on slice `prompt.frame`. */
export function extentOnSlice(axis: Axis, prompt: Prompt): Box {
  const [ra, ca] = sliceAxes(axis);
  const rows = [
    ...(prompt.box ? [prompt.box[0], prompt.box[2]] : []),
    ...prompt.points.map((p) => p.row),
  ];
  const cols = [
    ...(prompt.box ? [prompt.box[1], prompt.box[3]] : []),
    ...prompt.points.map((p) => p.col),
  ];
  const lo: Vec3 = [0, 0, 0];
  const hi: Vec3 = [0, 0, 0];
  lo[axis] = prompt.frame;
  hi[axis] = prompt.frame + 1;
  lo[ra] = Math.min(...rows);
  hi[ra] = Math.max(...rows) + 1;
  lo[ca] = Math.min(...cols);
  hi[ca] = Math.max(...cols) + 1;
  return { lo, hi };
}

/**
 * Calls `emit` with each slice of `crop` in turn, as `rows * cols` bytes (the buffer is reused:
 * `emit` must finish with it before it returns). `region` holds the 8-bit voxels of `box`.
 */
export async function eachFrame(
  region: { box: Box; data: Uint8Array },
  crop: Box,
  axis: Axis,
  emit: (frame: Uint8Array) => Promise<boolean>,
): Promise<void> {
  const [ra, ca] = sliceAxes(axis);
  const s = stridesOf(dimsOf(region.box.lo, region.box.hi));
  const cd = dimsOf(crop.lo, crop.hi);
  const [rows, cols] = [cd[ra], cd[ca]];
  const frame = new Uint8Array(rows * cols);
  const offset = (i: Axis) => crop.lo[i] - region.box.lo[i];
  const rowOrigin = offset(ra) * s[ra] + offset(ca) * s[ca];
  for (let f = 0; f < cd[axis]; f++) {
    const base = (offset(axis) + f) * s[axis] + rowOrigin;
    for (let y = 0; y < rows; y++) {
      const from = base + y * s[ra];
      if (s[ca] === 1) frame.set(region.data.subarray(from, from + cols), y * cols);
      else for (let x = 0; x < cols; x++) frame[y * cols + x] = region.data[from + x * s[ca]] ?? 0;
    }
    if (!(await emit(frame))) return;
  }
}
