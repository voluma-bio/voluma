/**
 * Marks over a pane: a 2D canvas above the pane's WebGL canvas, drawn in screen pixels so a dot,
 * a dash and a label keep their size at any zoom. Each pane projects source voxels (z, y, x) to
 * its own CSS pixels; a slice draws only the part of a mark that lies on its slice, 3D draws
 * all of it over the anatomy. Also the measures a mark carries (a line's mm, an outline's mm²).
 */
import { sliceSegment } from "./geometry";
import { type Axis, type GridMark, planeAxes, type ShownMark, type Zyx } from "./scene";
import { tokenColor } from "./token-color";

/** A source position to the pane's CSS pixels, or null where the pane can't show it. */
export type Project = (p: Zyx) => readonly [number, number] | null;

/** What one mark draws, in source voxels: polylines, dots and a measure. */
type Shape = {
  lines: { points: Zyx[]; closed: boolean }[];
  dots: Zyx[];
  measure?: { at: Zyx; text: string };
};

export function overlayCanvas(host: HTMLElement): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.className = "pointer-events-none absolute inset-0";
  host.append(canvas);
  return canvas;
}

export function sizeOverlay(canvas: HTMLCanvasElement, width: number, height: number) {
  const dpr = globalThis.devicePixelRatio;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
}

/** mm between two positions on a grid with this spacing (z, y, x). */
export function lengthMm(a: Zyx, b: Zyx, spacingZyx: Zyx): number {
  return Math.hypot(...a.map((v, k) => (b[k]! - v) * spacingZyx[k]!));
}

/** A closed outline's area in mm², its points all on one slice holding `axis`. */
export function areaMm2(points: readonly Zyx[], axis: Axis, spacingZyx: Zyx): number {
  const [ra, ca] = planeAxes(axis);
  let twice = 0;
  points.forEach((p, i) => {
    const q = points[(i + 1) % points.length]!;
    twice += p[ca] * q[ra] - q[ca] * p[ra];
  });
  return (Math.abs(twice) / 2) * spacingZyx[ra] * spacingZyx[ca];
}

/** At most `max` of the points, evenly picked, first kept: the contract caps an outline at 500. */
export function thin<T>(points: readonly T[], max: number): T[] {
  if (points.length <= max) return [...points];
  return Array.from({ length: max }, (_, i) => points[Math.floor((i * points.length) / max)]!);
}

/** Three significant figures: 0.112, 1.39, 12.3. */
const measure = (n: number) => String(Number(n.toPrecision(3)));

const mid = (points: readonly Zyx[]): Zyx =>
  [0, 1, 2].map((k) => points.reduce((s, p) => s + p[k]!, 0) / points.length) as unknown as Zyx;

/** The part of a mark on the slice holding `axis` at `at` (a source voxel), or null. */
export function sliceShape(mark: GridMark, axis: Axis, at: number): Shape | null {
  const [ra, ca] = planeAxes(axis);
  const onSlice = (p: Zyx) => Math.abs(p[axis] - at) <= 0.5;
  if ("point" in mark) return onSlice(mark.point) ? { lines: [], dots: [mark.point] } : null;
  if ("box" in mark) {
    const { min, max } = mark.box;
    if (at < min[axis] - 0.5 || at > max[axis] + 0.5) return null;
    // Voxel i spans i ± ½: the outline goes round the boxed voxels.
    const corner = (r: number, c: number) => {
      const p = [0, 0, 0];
      p[axis] = at;
      p[ra] = r;
      p[ca] = c;
      return p as unknown as Zyx;
    };
    const [r0, r1, c0, c1] = [min[ra] - 0.5, max[ra] + 0.5, min[ca] - 0.5, max[ca] + 0.5];
    return {
      lines: [
        { points: [corner(r0, c0), corner(r0, c1), corner(r1, c1), corner(r1, c0)], closed: true },
      ],
      dots: [],
    };
  }
  if ("line" in mark) {
    const { aZyx, bZyx, lengthMm } = mark.line;
    const segment = sliceSegment(aZyx, bZyx, axis, at);
    if (!segment) return null;
    // A line crossing the slice shows a dot where it crosses; its length shows where it lies.
    const ends = [aZyx, bZyx].filter(onSlice);
    const whole = ends.length === 2;
    return {
      lines: [{ points: segment, closed: false }],
      dots: ends.length ? ends : [mid(segment)],
      ...(whole && { measure: { at: mid(segment), text: `${measure(lengthMm)} mm` } }),
    };
  }
  const { outline } = mark;
  if (outline.axis !== axis || !onSlice(outline.zyx[0]!)) return null;
  return {
    lines: [{ points: outline.zyx, closed: true }],
    dots: [],
    measure: { at: mid(outline.zyx), text: `${measure(outline.areaMm2)} mm²` },
  };
}

/** The whole mark, for 3D. */
export function wholeShape(mark: GridMark): Shape {
  if ("point" in mark) return { lines: [], dots: [mark.point] };
  if ("box" in mark) {
    const { min, max } = mark.box;
    const lo = min.map((v) => v - 0.5);
    const hi = max.map((v) => v + 0.5);
    const corner = (i: number) =>
      [0, 1, 2].map((k) => ((i >> k) & 1 ? hi[k]! : lo[k]!)) as unknown as Zyx;
    // The 12 edges: corners that differ in one bit.
    const lines = [];
    for (let i = 0; i < 8; i++)
      for (const bit of [1, 2, 4])
        if (!(i & bit)) lines.push({ points: [corner(i), corner(i | bit)], closed: false });
    return { lines, dots: [] };
  }
  if ("line" in mark) {
    const { aZyx, bZyx, lengthMm } = mark.line;
    return {
      lines: [{ points: [aZyx, bZyx], closed: false }],
      dots: [aZyx, bZyx],
      measure: { at: mid([aZyx, bZyx]), text: `${measure(lengthMm)} mm` },
    };
  }
  const { outline } = mark;
  return {
    lines: [{ points: outline.zyx, closed: true }],
    dots: [],
    measure: { at: mid(outline.zyx), text: `${measure(outline.areaMm2)} mm²` },
  };
}

/**
 * Clears `canvas` and draws the marks, a mark being drawn (`draft`) and the ring where a point
 * would land (`hover`). `shapeOf` says what of a mark this pane shows.
 */
export function drawMarks(
  canvas: HTMLCanvasElement,
  project: Project,
  shapeOf: (mark: GridMark) => Shape | null,
  marks: readonly ShownMark[],
  draft: GridMark | null,
  hover: Zyx | null,
) {
  const ctx = canvas.getContext("2d")!;
  const dpr = globalThis.devicePixelRatio;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!marks.length && !draft && !hover) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const ink = {
    you: tokenColor("--mark-mine"),
    ai: tokenColor("--mark-ai"),
    well: tokenColor("--viewer-well"),
    chip: tokenColor("--viewer-chip"),
    chipFg: tokenColor("--viewer-chip-fg"),
  };
  ctx.font = "11px ui-monospace, SFMono-Regular, Menlo, monospace";
  ctx.textBaseline = "middle";
  const shown: ShownMark[] = [...marks];
  if (draft) shown.push({ id: "", mark: draft, by: "you" });
  for (const m of shown) {
    const shape = shapeOf(m.mark);
    if (!shape) continue;
    const color = ink[m.by];
    const width = m.selected ? 3 : 2;
    const dash = m.by === "ai" ? [5, 4] : [];
    for (const line of shape.lines) {
      const points = line.points.map(project);
      if (points.some((p) => !p)) continue;
      const path = () => {
        ctx.beginPath();
        for (const [i, p] of points.entries()) {
          if (i) ctx.lineTo(p![0], p![1]);
          else ctx.moveTo(p![0], p![1]);
        }
        if (line.closed) ctx.closePath();
      };
      // A dark edge keeps the line readable over bright bone.
      path();
      ctx.setLineDash([]);
      ctx.strokeStyle = ink.well;
      ctx.lineWidth = width + 2;
      ctx.stroke();
      ctx.setLineDash(dash);
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.stroke();
    }
    ctx.setLineDash([]);
    for (const dot of shape.dots) {
      const p = project(dot);
      if (!p) continue;
      ctx.beginPath();
      ctx.arc(p[0], p[1], m.selected ? 5 : 4, 0, 2 * Math.PI);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.strokeStyle = ink.well;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    const anchor = project(shape.measure?.at ?? shape.lines[0]?.points[0] ?? shape.dots[0]!);
    if (!anchor) continue;
    let x = anchor[0] + 8;
    const y = anchor[1] - 10;
    if (m.tag) {
      const w = ctx.measureText(m.tag).width + 8;
      ctx.fillStyle = color;
      ctx.fillRect(x, y - 8, w, 16);
      ctx.fillStyle = ink.well;
      ctx.fillText(m.tag, x + 4, y);
      x += w + 2;
    }
    if (shape.measure) {
      const w = ctx.measureText(shape.measure.text).width + 8;
      ctx.fillStyle = ink.chip;
      ctx.fillRect(x, y - 8, w, 16);
      ctx.fillStyle = ink.chipFg;
      ctx.fillText(shape.measure.text, x + 4, y);
    }
  }
  const ring = hover && project(hover);
  if (ring) {
    ctx.beginPath();
    ctx.arc(ring[0], ring[1], 8, 0, 2 * Math.PI);
    ctx.strokeStyle = ink.well;
    ctx.lineWidth = 3.5;
    ctx.stroke();
    ctx.strokeStyle = ink.you;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
}
