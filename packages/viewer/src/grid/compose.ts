/**
 * A slice pane's picture: the image plane in grey through the window, overlays blended on top,
 * or drawn as their edge (`Overlay.outline`).
 */
import { Color } from "three";
import type { Plane } from "./planes";
import { type Axis, type Overlay, planeAxes } from "./scene";

export type Window = { low: number; high: number };
/** An overlay's plane, at its own level (`scale`) and crop offset. */
export type OverlayPlane = { overlay: Overlay; plane: Plane; scale: number };

const OVERLAY_ALPHA = 0.45;

const rgbCache = new Map<string, [number, number, number]>();
function rgb(color: string): [number, number, number] {
  let value = rgbCache.get(color);
  if (!value) {
    const c = new Color(color);
    value = [c.r * 255, c.g * 255, c.b * 255];
    rgbCache.set(color, value);
  }
  return value;
}

/** Level voxel of `overlay` under each image pixel along one plane axis; -1 outside the crop. */
function lookup(count: number, imageScale: number, offset: number, scale: number, size: number) {
  const out = new Int32Array(count);
  for (let i = 0; i < count; i++) {
    // The image voxel's centre in source voxels, then the overlay voxel that holds it.
    const j = Math.floor((i * imageScale + (imageScale - 1) / 2 - offset) / scale);
    out[i] = j >= 0 && j < size ? j : -1;
  }
  return out;
}

export function compose(
  image: Plane,
  imageScale: number,
  axis: Axis,
  window: Window,
  overlays: OverlayPlane[],
): Uint8Array {
  const { rows, cols, data } = image;
  const rgba = new Uint8Array(rows * cols * 4);
  const span = window.high - window.low || 1;
  for (let i = 0; i < rows * cols; i++) {
    const g = Math.max(0, Math.min(255, ((data[i]! - window.low) / span) * 255));
    rgba[i * 4] = g;
    rgba[i * 4 + 1] = g;
    rgba[i * 4 + 2] = g;
    rgba[i * 4 + 3] = 255;
  }
  const [ra, ca] = planeAxes(axis);
  for (const { overlay, plane, scale } of overlays) {
    const rowOf = lookup(rows, imageScale, overlay.offsetZyx[ra], scale, plane.rows);
    const colOf = lookup(cols, imageScale, overlay.offsetZyx[ca], scale, plane.cols);
    const single = typeof overlay.color === "string" ? rgb(overlay.color) : null;
    const byLabel = typeof overlay.color === "string" ? null : overlay.color;
    /** The overlay value under image pixel (r, c), 0 outside the crop or the picture. */
    const at = (r: number, c: number) => {
      const pr = r < 0 || r >= rows ? -1 : rowOf[r]!;
      const pc = c < 0 || c >= cols ? -1 : colOf[c]!;
      return pr < 0 || pc < 0 ? 0 : plane.data[pr * plane.cols + pc]!;
    };
    const alpha = overlay.outline ? 1 : OVERLAY_ALPHA;
    for (let r = 0; r < rows; r++) {
      if (rowOf[r]! < 0) continue;
      for (let c = 0; c < cols; c++) {
        const value = at(r, c);
        if (!value) continue;
        const hex = byLabel?.[value];
        const color = single ?? (hex ? rgb(hex) : null);
        if (!color) continue;
        // An outline paints only the pixels whose region ends beside them.
        if (
          overlay.outline &&
          at(r - 1, c) === value &&
          at(r + 1, c) === value &&
          at(r, c - 1) === value &&
          at(r, c + 1) === value
        )
          continue;
        const o = (r * cols + c) * 4;
        rgba[o] = rgba[o]! * (1 - alpha) + color[0] * alpha;
        rgba[o + 1] = rgba[o + 1]! * (1 - alpha) + color[1] * alpha;
        rgba[o + 2] = rgba[o + 2]! * (1 - alpha) + color[2] * alpha;
      }
    }
  }
  return rgba;
}

/** A window that spans the image's values: the 1st to the 99.9th percentile of a coarse level. */
export function autoWindow(values: ArrayLike<number>): Window {
  const sample: number[] = [];
  const step = Math.max(1, Math.floor(values.length / 200_000));
  for (let i = 0; i < values.length; i += step) sample.push(values[i]!);
  sample.sort((a, b) => a - b);
  const at = (q: number) => sample[Math.min(sample.length - 1, Math.floor(q * sample.length))] ?? 0;
  const low = at(0.01);
  const high = at(0.999);
  return { low, high: high > low ? high : low + 1 };
}
