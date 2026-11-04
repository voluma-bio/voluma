/** A slice pane's picture: the image in grey between its contrast limits, overlays blended on top. */
import { Color } from "three";
import type { Plane } from "./planes";
import { type Axis, type Overlay, planeAxes } from "./scene";

export type Contrast = { low: number; high: number };
/** An overlay's plane, at its own level (`scale`) and crop offset. */
export type OverlayPlane = { overlay: Overlay; plane: Plane; scale: number };

const OVERLAY_ALPHA = 0.45;
/** An outlined region's fill; its edge is opaque. */
const OUTLINED_ALPHA = 0.65;

const rgbCache = new Map<string, [number, number, number]>();
function rgb(color: string): [number, number, number] {
  let value = rgbCache.get(color);
  if (!value) {
    // Picture bytes are sRGB; Three.js parses CSS colours into linear RGB.
    const c = new Color(color).convertLinearToSRGB();
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
  contrast: Contrast,
  overlays: OverlayPlane[],
): Uint8Array {
  const { rows, cols, data } = image;
  const rgba = grey(data, rows * cols, contrast);
  const [ra, ca] = planeAxes(axis);
  for (const { overlay, plane, scale } of overlays) {
    const rowOf = lookup(rows, imageScale, overlay.offsetZyx[ra], scale, plane.rows);
    const colOf = lookup(cols, imageScale, overlay.offsetZyx[ca], scale, plane.cols);
    // The overlay's value under each pixel, 0 outside its crop.
    const values = new Float32Array(rows * cols);
    for (let r = 0; r < rows; r++) {
      const pr = rowOf[r]!;
      if (pr < 0) continue;
      for (let c = 0; c < cols; c++) {
        const pc = colOf[c]!;
        if (pc >= 0) values[r * cols + c] = plane.data[pr * plane.cols + pc]!;
      }
    }
    blend(rgba, cols, overlay, values);
  }
  return rgba;
}

/**
 * A resliced picture (`reslice.ts`), `cols` pixels wide: the image's values and each overlay's,
 * one per pixel. A pixel off the image (NaN) is left transparent.
 */
export function composeSampled(
  values: ArrayLike<number>,
  cols: number,
  contrast: Contrast,
  overlays: { overlay: Overlay; values: ArrayLike<number> }[],
): Uint8Array {
  const rgba = grey(values, values.length, contrast);
  for (const layer of overlays) blend(rgba, cols, layer.overlay, layer.values);
  return rgba;
}

/**
 * Blends an overlay's values, one per pixel of a picture `cols` wide, into its visible pixels:
 * each value's colour at its opacity, nothing for 0 or an uncoloured label. An outlined value is
 * filled stronger, and opaque where a 4-neighbour inside the picture holds another value.
 */
function blend(rgba: Uint8Array, cols: number, overlay: Overlay, values: ArrayLike<number>) {
  const single = typeof overlay.color === "string" ? rgb(overlay.color) : null;
  const byLabel = typeof overlay.color === "string" ? null : overlay.color;
  const opacityOf = (value: number) =>
    typeof overlay.opacity === "number" ? overlay.opacity : (overlay.opacity[value] ?? 1);
  const outlined = (value: number) =>
    typeof overlay.outline === "object" ? !!overlay.outline[value] : !!overlay.outline;
  const rows = values.length / cols;
  // NaN off a resliced picture counts as no value.
  const at = (i: number) => values[i]! || 0;
  for (let i = 0; i < values.length; i++) {
    const value = at(i);
    if (!value || !rgba[i * 4 + 3]) continue;
    const hex = byLabel?.[value];
    const color = single ?? (hex ? rgb(hex) : null);
    if (!color) continue;
    let a = OVERLAY_ALPHA;
    if (outlined(value)) {
      const r = Math.floor(i / cols);
      const c = i - r * cols;
      const edge =
        (r > 0 && at(i - cols) !== value) ||
        (r < rows - 1 && at(i + cols) !== value) ||
        (c > 0 && at(i - 1) !== value) ||
        (c < cols - 1 && at(i + 1) !== value);
      a = edge ? 1 : OUTLINED_ALPHA;
    }
    a *= opacityOf(value);
    const o = i * 4;
    rgba[o] = rgba[o]! * (1 - a) + color[0] * a;
    rgba[o + 1] = rgba[o + 1]! * (1 - a) + color[1] * a;
    rgba[o + 2] = rgba[o + 2]! * (1 - a) + color[2] * a;
  }
}

function grey(data: ArrayLike<number>, count: number, contrast: Contrast): Uint8Array {
  const rgba = new Uint8Array(count * 4);
  const span = contrast.high - contrast.low || 1;
  for (let i = 0; i < count; i++) {
    const v = data[i]!;
    if (Number.isNaN(v)) continue;
    const g = Math.max(0, Math.min(255, ((v - contrast.low) / span) * 255));
    rgba[i * 4] = g;
    rgba[i * 4 + 1] = g;
    rgba[i * 4 + 2] = g;
    rgba[i * 4 + 3] = 255;
  }
  return rgba;
}

/** Contrast limits that span the image's values: the 1st to the 99.9th percentile of a coarse level. */
export function autoContrast(values: ArrayLike<number>): Contrast {
  const sample: number[] = [];
  const step = Math.max(1, Math.floor(values.length / 200_000));
  for (let i = 0; i < values.length; i += step) sample.push(values[i]!);
  sample.sort((a, b) => a - b);
  const at = (q: number) => sample[Math.min(sample.length - 1, Math.floor(q * sample.length))] ?? 0;
  const low = at(0.01);
  const high = at(0.999);
  return { low, high: high > low ? high : low + 1 };
}
