/**
 * What the grid viewer draws: one analysis grid with its image, the overlays and meshes made
 * on that same grid, all from converted review assets (OME-Zarr levels and raw meshes). Every
 * position is a source voxel (z, y, x) of the grid; the viewer never resamples between grids.
 */

import type { Mark } from "@voluma/contracts/messages";

export type Zyx = readonly [number, number, number];

/**
 * A mark on the grid in source voxels (z, y, x): a voxel, an inclusive box, a line or a closed
 * outline on one slice, exactly as `Mark` (`@voluma/contracts/messages`) without its `volumeId`.
 */
export type GridMark =
  | Required<Pick<Mark, "point">>
  | Required<Pick<Mark, "box">>
  | Required<Pick<Mark, "line">>
  | Required<Pick<Mark, "outline">>;

/** What a marking gesture makes; none is the viewer's own navigation. */
export type MarkTool = "point" | "box" | "line" | "outline";

/** A mark as drawn: the person's own in `--mark-mine`, the AI's dashed in `--mark-ai`. */
export type ShownMark = {
  id: string;
  mark: GridMark;
  by: "you" | "ai";
  /** A short name drawn beside it ("P1"). */
  tag?: string;
  selected?: boolean;
};

/** One OME-Zarr level: `scaleZyx` source voxels per level voxel (2^k on every axis). */
export type AssetLevel = { path: string; shapeZyx: Zyx; scaleZyx: Zyx };

/** One converted file's levels, under an absolute URL prefix ending in "/"; covers the whole grid. */
export type ZarrSource = {
  base: string;
  /** Finest first. */
  levels: AssetLevel[];
};

export type Overlay = ZarrSource & {
  /** Where crop voxel (0, 0, 0) sits on the grid: zeros for a volume of the whole grid. */
  offsetZyx: Zyx;
  id: string;
  name: string;
  /** One colour for every nonzero voxel (a mask), or one per label value; a label without one isn't drawn. */
  color: string | Readonly<Record<number, string>>;
  /** 0 to 1, of the overlay's full blend: one for the mask, or one per label value (default 1). */
  opacity: number | Readonly<Record<number, number>>;
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
  /** 0 hides the mesh but keeps it loaded. */
  opacity: number;
  /** A surface sheet also intersects each slice as a trace. */
  trace?: boolean;
};

/** Published annotations, mapped from world mm into this grid's source voxels. */
export type GridAnnotation = {
  id: string;
  name: string;
  points: readonly Zyx[];
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
  annotations: GridAnnotation[];
};

/** The array axis a slice pane holds constant, and the axes of its rows and columns. */
export type Axis = 0 | 1 | 2;
export const planeAxes = (axis: Axis): [Axis, Axis] =>
  axis === 0 ? [1, 2] : axis === 1 ? [0, 2] : [0, 1];

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
 * The level voxel that holds source position `p` along one axis (a voxel, or a coarser voxel's
 * centre), or -1 outside the level. Level voxel i covers source [i·s, (i+1)·s) after the crop offset.
 */
export function levelIndex(p: number, offset: number, scale: number, size: number): number {
  const i = Math.floor((p - offset) / scale);
  return i >= 0 && i < size ? i : -1;
}

type Vec3 = [number, number, number];

/**
 * A pane's own view: a slice pane's zoom (× the zoom that fits the grid) and centre in pane mm,
 * or the 3D camera in the grid's mm (x, y, z).
 */
export type PaneView =
  | { zoom: number; center: [number, number] }
  | { camera: { position: Vec3; target: Vec3; up: Vec3 } };

/** What a pane does for screenshots: its pixels as drawn now, and showing a saved view. */
export type PaneHandle = {
  capture(): { pngBase64: string; width: number; height: number; view: PaneView };
  show(view: PaneView): void;
  /**
   * Draws the pane now and returns its canvases, bottom first (the picture, then the marks), to be
   * copied in the same task: WebGL clears its buffer once the browser composites it. Empty while
   * loading, refining or failed. The marks exclude the unfinished gesture and hover cursor.
   */
  layers(): HTMLCanvasElement[];
};

/** Draws the pane now and reads its canvas, before the browser clears the drawing buffer. */
export function capturePane(canvas: HTMLCanvasElement, draw: () => void) {
  draw();
  return {
    pngBase64: canvas.toDataURL("image/png").slice("data:image/png;base64,".length),
    width: canvas.width,
    height: canvas.height,
  };
}
