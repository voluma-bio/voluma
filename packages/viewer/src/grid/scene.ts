/**
 * What the grid viewer draws: one analysis grid with its image, the overlays and meshes made
 * on that same grid, all from converted review assets (OME-Zarr levels and raw meshes). Every
 * position is a source voxel (z, y, x) of the grid; the viewer never resamples between grids.
 */

export type Zyx = readonly [number, number, number];

/** One OME-Zarr level: `scaleZyx` source voxels per level voxel (2^k on every axis). */
export type AssetLevel = { path: string; shapeZyx: Zyx; scaleZyx: Zyx };

/** One converted file's levels, under an absolute URL prefix ending in "/". */
export type ZarrSource = {
  base: string;
  /** Finest first. */
  levels: AssetLevel[];
  /** Where crop voxel (0, 0, 0) sits on the grid: zeros for a volume of the whole grid. */
  offsetZyx: Zyx;
};

export type Overlay = ZarrSource & {
  id: string;
  name: string;
  /** One colour for every nonzero voxel (a mask), or one per label value. */
  color: string | Readonly<Record<number, string>>;
};

/** float32 vertices (x, y, z) in source voxels, then uint32 indices, little-endian. */
export type GridMesh = {
  id: string;
  name: string;
  url: string;
  vertices: number;
  indices: number;
  offsetZyx: Zyx;
  color: string;
  opacity: number;
};

export type GridScene = {
  /** Source voxels of the grid. */
  shapeZyx: Zyx;
  /** mm per voxel along z, y, x: the norms of the affine's columns. */
  spacingZyx: Zyx;
  image: ZarrSource;
  overlays: Overlay[];
  meshes: GridMesh[];
};

/** The array axis a slice pane holds constant, and the axes of its rows and columns. */
export type Axis = 0 | 1 | 2;
export const planeAxes = (axis: Axis): [Axis, Axis] =>
  axis === 0 ? [1, 2] : axis === 1 ? [0, 2] : [0, 1];

/** mm per voxel along z, y, x of a voxel (x, y, z) to world mm affine (4×4, row-major). */
export function spacingOf(affine: readonly (readonly number[])[]): Zyx {
  const column = (j: number) => Math.hypot(affine[0]![j]!, affine[1]![j]!, affine[2]![j]!);
  return [column(2), column(1), column(0)];
}

/**
 * The coarsest level that still gives each device pixel at least one voxel: `voxelsPerPixel`
 * source voxels fall on one device pixel at the current zoom.
 */
export function levelFor(levels: readonly AssetLevel[], voxelsPerPixel: number): number {
  let best = 0;
  levels.forEach((level, i) => {
    if (Math.max(...level.scaleZyx) <= Math.max(1, voxelsPerPixel)) best = i;
  });
  return best;
}

/**
 * The level voxel that holds source voxel `p` along one axis, or -1 outside the level. Level
 * voxel i covers source voxels [i·s, (i+1)·s) after the source's crop offset.
 */
export function levelIndex(p: number, offset: number, scale: number, size: number): number {
  const i = Math.floor((Math.round(p) - offset) / scale);
  return i >= 0 && i < size ? i : -1;
}
