/**
 * A tilted slice pane's picture, resliced from a level's zarr chunks: the image trilinear,
 * overlays nearest (a label never blends). Samples are `step` mm apart on the plane and cover the
 * grid's whole outline on it, so panning never needs a new picture; only moving or turning the
 * plane, or zooming to another level, does. The main thread works out where the samples lie
 * (`sampling`, `onLevel`); the zarr worker fetches the chunks they cross (`crossed`) and samples
 * them (`sample`). Untilted panes read whole slices of the grid instead (`planes.ts`).
 */
import type { Basis } from "./frame";
import type { Zyx } from "./scene";

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

/**
 * The same samples in one level's voxel coordinates (z, y, x), level voxel j centred on j:
 * sample (r, c) lies at `origin + r·row + c·col`.
 */
export type LevelSampling = {
  origin: number[];
  row: number[];
  col: number[];
  rows: number;
  cols: number;
};

/** A level's decoded chunks, C order by chunk index; each `size` voxels, the edge ones padded. */
export type ChunkGrid = {
  shape: readonly number[];
  size: readonly number[];
  chunks: readonly { data: ArrayLike<number>; stride: readonly number[] }[];
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
 * `s` in the voxels of a level of `scale` source voxels each, cropped at `offset` (source
 * voxels): level voxel j is centred on source j·scale + (scale − 1)/2 after the offset.
 */
export function onLevel(
  s: Sampling,
  basis: Basis,
  spacingZyx: Zyx,
  scale: Zyx,
  offset: Zyx,
): LevelSampling {
  const point = (mm: number, k: number) =>
    (mm / spacingZyx[k]! - offset[k]! - (scale[k]! - 1) / 2) / scale[k]!;
  const vector = (mm: number, k: number) => mm / spacingZyx[k]! / scale[k]!;
  return {
    origin: [0, 1, 2].map((k) =>
      point(s.x0 * basis.right[k]! - s.y0 * basis.down[k]! + s.depth * basis.normal[k]!, k),
    ),
    row: [0, 1, 2].map((k) => vector(s.step * basis.down[k]!, k)),
    col: [0, 1, 2].map((k) => vector(s.step * basis.right[k]!, k)),
    rows: s.rows,
    cols: s.cols,
  };
}

/**
 * Walks the samples on the level, calling `inside` with each one's voxel neighbourhood: the
 * lower and upper voxel per axis (clamped to the edge voxels) and the fractions between them.
 * Samples beyond the level's outer voxel faces are skipped.
 */
function walk(
  at: LevelSampling,
  [nz, ny, nx]: readonly number[],
  inside: (
    i: number,
    z0: number,
    y0: number,
    x0: number,
    fz: number,
    fy: number,
    fx: number,
  ) => void,
) {
  const [oz, oy, ox] = at.origin as [number, number, number];
  const [rz, ry, rx] = at.row as [number, number, number];
  const [cz, cy, cx] = at.col as [number, number, number];
  for (let r = 0; r < at.rows; r++) {
    let z = oz + r * rz;
    let y = oy + r * ry;
    let x = ox + r * rx;
    for (let c = 0; c < at.cols; c++, z += cz, y += cy, x += cx) {
      if (z < -0.5 || y < -0.5 || x < -0.5 || z > nz! - 0.5 || y > ny! - 0.5 || x > nx! - 0.5)
        continue;
      const z0 = Math.max(0, Math.min(nz! - 1, Math.floor(z)));
      const y0 = Math.max(0, Math.min(ny! - 1, Math.floor(y)));
      const x0 = Math.max(0, Math.min(nx! - 1, Math.floor(x)));
      inside(r * at.cols + c, z0, y0, x0, z - z0, y - y0, x - x0);
    }
  }
}

/** The chunks (C-order chunk indices) the samples read: every voxel trilinear or nearest needs. */
export function crossed(at: LevelSampling, shape: readonly number[], size: readonly number[]) {
  const [nz, ny, nx] = shape as [number, number, number];
  const [sz, sy, sx] = size as [number, number, number];
  const [gy, gx] = [Math.ceil(ny / sy), Math.ceil(nx / sx)];
  const hit = new Uint8Array(Math.ceil(nz / sz) * gy * gx);
  walk(at, shape, (_, z0, y0, x0) => {
    for (const k of [z0, Math.min(nz - 1, z0 + 1)])
      for (const j of [y0, Math.min(ny - 1, y0 + 1)])
        for (const i of [x0, Math.min(nx - 1, x0 + 1)])
          hit[(Math.floor(k / sz) * gy + Math.floor(j / sy)) * gx + Math.floor(i / sx)] = 1;
  });
  const out: number[] = [];
  for (let c = 0; c < hit.length; c++) if (hit[c]) out.push(c);
  return out;
}

/**
 * The level sampled on the plane from its chunks (every one `crossed` names): trilinear, NaN
 * outside the level; or nearest, 0 outside it.
 */
export function sample(at: LevelSampling, grid: ChunkGrid, nearest: boolean): Float32Array {
  const out = new Float32Array(at.rows * at.cols).fill(nearest ? 0 : Number.NaN);
  const [nz, ny, nx] = grid.shape as [number, number, number];
  const [sz, sy, sx] = grid.size as [number, number, number];
  const [gy, gx] = [Math.ceil(ny / sy), Math.ceil(nx / sx)];
  const { chunks } = grid;
  const voxel = (k: number, j: number, i: number) => {
    const ck = Math.floor(k / sz);
    const cj = Math.floor(j / sy);
    const ci = Math.floor(i / sx);
    const { data, stride } = chunks[(ck * gy + cj) * gx + ci]!;
    return data[
      (k - ck * sz) * stride[0]! + (j - cj * sy) * stride[1]! + (i - ci * sx) * stride[2]!
    ]!;
  };
  walk(at, grid.shape, (i, z0, y0, x0, fz, fy, fx) => {
    if (nearest) {
      out[i] = voxel(
        fz < 0.5 ? z0 : Math.min(nz - 1, z0 + 1),
        fy < 0.5 ? y0 : Math.min(ny - 1, y0 + 1),
        fx < 0.5 ? x0 : Math.min(nx - 1, x0 + 1),
      );
      return;
    }
    // Clamped at the edge voxels: a sample in the outer half voxel takes the edge value.
    const z1 = Math.min(nz - 1, z0 + 1);
    const y1 = Math.min(ny - 1, y0 + 1);
    const x1 = Math.min(nx - 1, x0 + 1);
    const tz = Math.max(0, Math.min(1, fz));
    const ty = Math.max(0, Math.min(1, fy));
    const tx = Math.max(0, Math.min(1, fx));
    const row = (k: number, j: number) => voxel(k, j, x0) * (1 - tx) + voxel(k, j, x1) * tx;
    const face = (k: number) => row(k, y0) * (1 - ty) + row(k, y1) * ty;
    out[i] = face(z0) * (1 - tz) + face(z1) * tz;
  });
  return out;
}

const dot = (a: readonly number[], b: readonly number[]) =>
  a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
