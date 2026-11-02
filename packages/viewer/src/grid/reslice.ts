/**
 * A tilted slice pane's picture, resliced in the browser from whole levels: the image trilinear,
 * overlays nearest (a label never blends). Samples are `step` mm apart on the plane and cover the
 * grid's whole outline on it, so panning never needs a new picture; only moving or turning the
 * plane does. Untilted panes read whole slices of the grid instead (`planes.ts`).
 */
import type { Basis } from "./frame";
import type { Zyx } from "./scene";

/** One whole level: `shape` level voxels, `scale` source voxels each, crop at `offset` (source voxels). */
export type Level3 = { data: ArrayLike<number>; shape: Zyx; scale: Zyx; offset: Zyx };

/**
 * Where the samples lie: `rows` × `cols`, `step` mm apart, the first centred on pane mm
 * (`x0`, `y0`); the plane is `depth` mm along the normal from the grid's origin.
 */
export type Sampling = {
  rows: number;
  cols: number;
  step: number;
  x0: number;
  y0: number;
  depth: number;
};

/** The longest side of a resliced picture, in samples: coarser steps beyond it. */
const MAX_SIDE = 1024;

/** The samples over the grid's outline on the plane through `at` (source voxel). */
export function sampling(
  basis: Basis,
  at: Zyx,
  spacingZyx: Zyx,
  shapeZyx: Zyx,
  step: number,
): Sampling {
  const mm = (p: readonly number[]) => p.map((v, k) => v * spacingZyx[k]!);
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i < 8; i++) {
    const corner = mm([0, 1, 2].map((k) => ((i >> k) & 1 ? shapeZyx[k]! - 0.5 : -0.5)));
    xs.push(dot(corner, basis.right));
    ys.push(-dot(corner, basis.down));
  }
  const [xMin, xMax, yMin, yMax] = [
    Math.min(...xs),
    Math.max(...xs),
    Math.min(...ys),
    Math.max(...ys),
  ];
  const fit = Math.max(step, (xMax - xMin) / MAX_SIDE, (yMax - yMin) / MAX_SIDE);
  return {
    cols: Math.ceil((xMax - xMin) / fit),
    rows: Math.ceil((yMax - yMin) / fit),
    step: fit,
    x0: xMin + fit / 2,
    y0: yMax - fit / 2,
    depth: dot(mm(at), basis.normal),
  };
}

/** The picture's corners in pane mm: top left, top right, bottom left, bottom right. */
export function samplingCorners(s: Sampling): [number, number][] {
  const left = s.x0 - s.step / 2;
  const top = s.y0 + s.step / 2;
  const right = left + s.cols * s.step;
  const bottom = top - s.rows * s.step;
  return [
    [left, top],
    [right, top],
    [left, bottom],
    [right, bottom],
  ];
}

/**
 * `level` sampled on the plane: trilinear, NaN outside it; or nearest, 0 outside it. Each
 * sample is a source position mapped to the level's voxel centres (level voxel j is centred on
 * source j·s + (s − 1)/2 after the crop offset).
 */
export function resample(
  level: Level3,
  s: Sampling,
  basis: Basis,
  spacingZyx: Zyx,
  nearest: boolean,
): Float32Array {
  const out = new Float32Array(s.rows * s.cols);
  // Level coordinates are linear in (row, column): start and steps.
  const toLevel = (mm: readonly number[], k: number, point: boolean) =>
    (mm[k]! / spacingZyx[k]! - (point ? level.offset[k]! + (level.scale[k]! - 1) / 2 : 0)) /
    level.scale[k]!;
  const first = [0, 1, 2].map(
    (k) => s.x0 * basis.right[k]! + s.y0 * -basis.down[k]! + s.depth * basis.normal[k]!,
  );
  const q0 = [0, 1, 2].map((k) => toLevel(first, k, true));
  const dc = [0, 1, 2].map((k) =>
    toLevel(
      basis.right.map((v) => v * s.step),
      k,
      false,
    ),
  );
  const dr = [0, 1, 2].map((k) =>
    toLevel(
      basis.down.map((v) => v * s.step),
      k,
      false,
    ),
  );
  const [nz, ny, nx] = level.shape;
  const { data } = level;
  const plane = ny * nx;
  for (let r = 0; r < s.rows; r++) {
    let z = q0[0]! + r * dr[0]!;
    let y = q0[1]! + r * dr[1]!;
    let x = q0[2]! + r * dr[2]!;
    for (let c = 0; c < s.cols; c++, z += dc[0]!, y += dc[1]!, x += dc[2]!) {
      const i = r * s.cols + c;
      if (z < -0.5 || y < -0.5 || x < -0.5 || z > nz - 0.5 || y > ny - 0.5 || x > nx - 0.5) {
        out[i] = nearest ? 0 : Number.NaN;
        continue;
      }
      if (nearest) {
        out[i] =
          data[
            Math.min(nz - 1, Math.round(z)) * plane +
              Math.min(ny - 1, Math.round(y)) * nx +
              Math.min(nx - 1, Math.round(x))
          ]!;
        continue;
      }
      out[i] = trilinear(data, level.shape, z, y, x);
    }
  }
  return out;
}

/** The level's value at level coordinates (z, y, x), clamped to its edge voxels. */
function trilinear(data: ArrayLike<number>, [nz, ny, nx]: Zyx, z: number, y: number, x: number) {
  const z0 = Math.max(0, Math.min(nz - 1, Math.floor(z)));
  const y0 = Math.max(0, Math.min(ny - 1, Math.floor(y)));
  const x0 = Math.max(0, Math.min(nx - 1, Math.floor(x)));
  const z1 = Math.min(nz - 1, z0 + 1);
  const y1 = Math.min(ny - 1, y0 + 1);
  const x1 = Math.min(nx - 1, x0 + 1);
  const fz = Math.max(0, Math.min(1, z - z0));
  const fy = Math.max(0, Math.min(1, y - y0));
  const fx = Math.max(0, Math.min(1, x - x0));
  const at = (k: number, j: number, i: number) => data[(k * ny + j) * nx + i]!;
  const row = (k: number, j: number) => at(k, j, x0) * (1 - fx) + at(k, j, x1) * fx;
  const face = (k: number) => row(k, y0) * (1 - fy) + row(k, y1) * fy;
  return face(z0) * (1 - fz) + face(z1) * fz;
}

/** The level's value at a source position: trilinear, or null outside it. */
export function valueAt(level: Level3, p: Zyx): number | null {
  const q = p.map((v, k) => (v - level.offset[k]! - (level.scale[k]! - 1) / 2) / level.scale[k]!);
  if (q.some((v, k) => v < -0.5 || v > level.shape[k]! - 0.5)) return null;
  return trilinear(level.data, level.shape, q[0]!, q[1]!, q[2]!);
}

/** The level's voxel holding a source position: its value, or 0 outside it. */
export function voxelAt(level: Level3, p: Zyx): number {
  // Level voxel j spans source [j·s − ½, (j+1)·s − ½).
  const q = p.map((v, k) => Math.floor((v - level.offset[k]! + 0.5) / level.scale[k]!));
  if (q.some((v, k) => v < 0 || v >= level.shape[k]!)) return 0;
  return level.data[(q[0]! * level.shape[1] + q[1]!) * level.shape[2] + q[2]!]!;
}

const dot = (a: readonly number[], b: readonly number[]) =>
  a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
