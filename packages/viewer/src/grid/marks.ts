/**
 * Marks over a pane: a 2D canvas above the pane's WebGL canvas, drawn in screen pixels so a dot,
 * a dash and a label keep their size at any zoom. Each pane projects source voxels (z, y, x) to
 * its own CSS pixels; a slice draws only the part of a mark that lies on its slice, 3D draws
 * all of it over the anatomy. `useMarkLayer` owns a pane's canvas, the mark being drawn and the
 * hover ring; moving those redraws only this canvas, never the pane's picture. Also the
 * measures a mark carries (a line's mm, an outline's mm²).
 */
import { type RefObject, useEffect, useRef, useState } from "react";
import type { Slab } from "./frame";
import { sliceSegment } from "./geometry";
import {
  type Axis,
  type GridMark,
  type MarkTool,
  planeAxes,
  type ShownMark,
  type Zyx,
} from "./scene";
import { tokenColor } from "./token-color";

/** A source position to the pane's CSS pixels, or null where the pane can't show it. */
type Project = (p: Zyx) => readonly [number, number] | null;

/**
 * How a pane shows marks now: its projection, what of a mark it shows, and the handles that tilt
 * the other planes (CSS px, each in its plane's colour).
 */
export type MarkView = {
  project: Project;
  shapeOf: (mark: GridMark) => Shape | null;
  handles?: readonly { x: number; y: number; color: string }[];
};

/**
 * A pane's mark canvas and the marking gesture in progress. The pane draws the canvas with each
 * frame, the layer alone for its own changes. One gesture at a time: `start` claims a pointer,
 * `cancel` ends it however it ends (release, Esc, a lost or cancelled pointer, another tool,
 * unmount) and runs the pane's own reset.
 */
export type MarkLayer = {
  canvas: HTMLCanvasElement;
  /** The mark being drawn, and where a point would land. */
  draft: GridMark | null;
  hover: Zyx | null;
  /** Draws now; snapshots omit the unfinished gesture and hover cursor. */
  draw(transient?: boolean): void;
  /** Draws at the next frame, the picture untouched. */
  redraw(): void;
  /** The pane's picture and then the marks, drawn now for a snapshot (`PaneHandle.layers`). */
  layers(picture: HTMLCanvasElement, paint: () => void): HTMLCanvasElement[];
  /**
   * A gesture begins with this pointer, captured on the pane unless `capture` is false (a 3D
   * click leaves the pointer to the orbit controls).
   */
  start(event: PointerEvent, capture?: boolean): void;
  /** Lets the pointer go and keeps the draft: a mark made by clicks, between clicks. */
  release(): void;
  /** Whether `event` is the gesture's pointer. */
  owns(event: PointerEvent): boolean;
  /** Ends the gesture: no draft, no ring, the pointer released, then the pane's own reset. */
  cancel(): void;
  /** The pane's reset of its own gesture state, run by every `cancel`; returns its removal. */
  onCancel(reset: () => void): () => void;
};

type Ink = Record<"you" | "ai" | "well" | "chip" | "chipFg", string>;

/**
 * The mark layer over `host`, sized with it. `view` is read at each draw (null before the pane
 * has a view). A new tool cancels the gesture, and Esc cancels one made with a tool.
 */
export function useMarkLayer(
  host: RefObject<HTMLElement | null>,
  view: () => MarkView | null,
  tool: MarkTool | null,
  marks: readonly ShownMark[],
): MarkLayer {
  const latest = useRef({ view, marks, tool });
  latest.current = { view, marks, tool };
  const [layer] = useState(() => {
    const canvas = document.createElement("canvas");
    // Above the pane's picture, below its chips.
    canvas.className = "pointer-events-none absolute inset-0 z-1";
    let ink: Ink | undefined;
    let frame = 0;
    let gesture: { pointerId: number; captured: boolean } | null = null;
    let reset = () => {};
    const own: MarkLayer = {
      canvas,
      draft: null,
      hover: null,
      draw(transient = true) {
        cancelAnimationFrame(frame);
        frame = 0;
        const v = latest.current.view();
        // The tokens, once: the theme is fixed for the viewer's life.
        ink ??= {
          you: tokenColor("--mark-mine"),
          ai: tokenColor("--mark-ai"),
          well: tokenColor("--viewer-well"),
          chip: tokenColor("--viewer-chip"),
          chipFg: tokenColor("--viewer-chip-fg"),
        };
        if (v)
          drawMarks(
            canvas,
            ink,
            v,
            latest.current.marks,
            transient ? own.draft : null,
            transient ? own.hover : null,
          );
      },
      redraw() {
        frame ||= requestAnimationFrame(() => own.draw());
      },
      layers(picture, paint) {
        paint();
        own.draw(false);
        own.redraw();
        return [picture, canvas];
      },
      start(event, capture = true) {
        gesture = { pointerId: event.pointerId, captured: capture };
        if (capture) host.current?.setPointerCapture(event.pointerId);
      },
      owns: (event) => gesture?.pointerId === event.pointerId,
      release() {
        const ended = gesture;
        gesture = null;
        const element = host.current;
        if (ended?.captured && element?.hasPointerCapture(ended.pointerId))
          element.releasePointerCapture(ended.pointerId);
      },
      cancel() {
        const ended = gesture;
        gesture = null;
        const element = host.current;
        if (ended?.captured && element?.hasPointerCapture(ended.pointerId))
          element.releasePointerCapture(ended.pointerId);
        own.draft = null;
        own.hover = null;
        own.redraw();
        reset();
      },
      onCancel(next) {
        reset = next;
        return () => {
          if (reset === next) reset = () => {};
        };
      },
    };
    return Object.assign(own, {
      stop() {
        cancelAnimationFrame(frame);
        frame = 0;
      },
      // A mark made by clicks is in progress between clicks too.
      active: () => gesture !== null || own.draft !== null,
    });
  });
  useEffect(() => {
    const element = host.current!;
    element.append(layer.canvas);
    const observer = new ResizeObserver(() => {
      const { width, height } = element.getBoundingClientRect();
      if (!width || !height) return;
      layer.canvas.width = Math.round(width * globalThis.devicePixelRatio);
      layer.canvas.height = Math.round(height * globalThis.devicePixelRatio);
      layer.canvas.style.width = `${width}px`;
      layer.canvas.style.height = `${height}px`;
      layer.draw();
    });
    observer.observe(element);
    // Only the pane's own capture: the orbit controls capture on the canvas inside it.
    const lost = (event: PointerEvent) => {
      if (event.target === element && layer.owns(event)) layer.cancel();
    };
    const cancelled = (event: PointerEvent) => {
      if (layer.owns(event)) layer.cancel();
    };
    // On the window, ahead of the page: one Esc drops the mark being drawn and does nothing else.
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !layer.active() || !latest.current.tool) return;
      event.preventDefault();
      event.stopPropagation();
      layer.cancel();
    };
    element.addEventListener("lostpointercapture", lost);
    element.addEventListener("pointercancel", cancelled);
    globalThis.addEventListener("keydown", key, { capture: true });
    return () => {
      layer.cancel();
      layer.stop();
      element.removeEventListener("lostpointercapture", lost);
      element.removeEventListener("pointercancel", cancelled);
      globalThis.removeEventListener("keydown", key, { capture: true });
      observer.disconnect();
      layer.canvas.remove();
    };
  }, [host, layer]);
  useEffect(() => {
    layer.redraw();
  }, [marks, layer]);
  // A tool put away or swapped mid-gesture leaves nothing behind.
  useEffect(() => layer.cancel(), [tool, layer]);
  return layer;
}

/** What one mark draws, in source voxels: polylines, dots and a measure. */
type Shape = {
  lines: { points: readonly Zyx[]; closed: boolean }[];
  dots: Zyx[];
  measure?: { at: Zyx; text: string };
};

/** mm between two positions on a grid with this spacing (z, y, x). */
export function lengthMm(a: Zyx, b: Zyx, spacingZyx: Zyx): number {
  return Math.hypot(...a.map((v, k) => (b[k]! - v) * spacingZyx[k]!));
}

/** A closed outline's area in mm², its points all on one plane (Newell's method, in mm). */
export function areaMm2(points: readonly Zyx[], spacingZyx: Zyx): number {
  const mm = points.map((p) => p.map((v, k) => v * spacingZyx[k]!));
  const sum = [0, 0, 0];
  mm.forEach((p, i) => {
    const q = mm[(i + 1) % mm.length]!;
    sum[0]! += (p[1]! - q[1]!) * (p[2]! + q[2]!);
    sum[1]! += (p[2]! - q[2]!) * (p[0]! + q[0]!);
    sum[2]! += (p[0]! - q[0]!) * (p[1]! + q[1]!);
  });
  return Math.hypot(...sum) / 2;
}

/** The angle at `vertex` between the rays to `a` and `b`, in degrees, on a grid with this spacing. */
export function angleDegrees(a: Zyx, vertex: Zyx, b: Zyx, spacingZyx: Zyx): number {
  const ray = (p: Zyx) => p.map((v, k) => (v - vertex[k]!) * spacingZyx[k]!);
  const u = ray(a);
  const w = ray(b);
  const cos =
    (u[0]! * w[0]! + u[1]! * w[1]! + u[2]! * w[2]!) / (Math.hypot(...u) * Math.hypot(...w));
  return (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI;
}

/** The array axis every point shares a value on, if any: where a contract outline must lie. */
export function outlineAxis(points: readonly Zyx[]): Axis | null {
  return ([0, 1, 2] as const).find((a) => points.every((p) => p[a] === points[0]![a])) ?? null;
}

/** At most `max` of the points, evenly picked, first kept: the contract caps an outline at 500. */
export function thin<T>(points: readonly T[], max: number): T[] {
  if (points.length <= max) return [...points];
  return Array.from({ length: max }, (_, i) => points[Math.floor((i * points.length) / max)]!);
}

/** Three significant figures: 0.112, 1.39, 12.3. */
const measure = (n: number) => String(Number(n.toPrecision(3)));

/** What a point says beside it: its note, cut short, or the value a probe read. */
function pointText(mark: Extract<GridMark, { point: Zyx }>): string | undefined {
  if (mark.note) return mark.note.length > 28 ? `${mark.note.slice(0, 27)}…` : mark.note;
  if (mark.probe) return probeText(mark.probe);
}

/** "≈ −172 HU": a probe's value, three significant figures. */
export function probeText(p: NonNullable<Extract<GridMark, { point: Zyx }>["probe"]>): string {
  const v = Math.abs(p.value) >= 100 ? String(Math.round(p.value)) : measure(p.value);
  return `${p.approx ? "≈ " : ""}${v.replace("-", "−")}${p.unit ? ` ${p.unit}` : ""}`;
}

const mid = (points: readonly Zyx[]): Zyx =>
  [0, 1, 2].map((k) => points.reduce((s, p) => s + p[k]!, 0) / points.length) as unknown as Zyx;

/**
 * The part of a mark on a slice pane's slice (`slab`; `whole` when the pane is untilted: the
 * axis it holds at a source voxel), or null. A box shows only on untilted panes.
 */
export function sliceShape(
  mark: GridMark,
  slab: Slab,
  whole: { axis: Axis; at: number } | null,
): Shape | null {
  const onSlice = (p: Zyx) => Math.abs(slab(p)) <= 0.5;
  if ("point" in mark) {
    if (!onSlice(mark.point)) return null;
    const text = pointText(mark);
    return { lines: [], dots: [mark.point], ...(text && { measure: { at: mark.point, text } }) };
  }
  if ("box" in mark) {
    if (!whole) return null;
    const { axis, at } = whole;
    const [ra, ca] = planeAxes(axis);
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
    const segment = sliceSegment(aZyx, bZyx, slab);
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
  if ("angle" in mark) {
    const { aZyx, vertexZyx, bZyx, degrees } = mark.angle;
    const arms = [sliceSegment(aZyx, vertexZyx, slab), sliceSegment(vertexZyx, bZyx, slab)].filter(
      (s): s is [Zyx, Zyx] => !!s,
    );
    if (!arms.length) return null;
    const ends = [aZyx, vertexZyx, bZyx].filter(onSlice);
    return {
      lines: arms.map((points) => ({ points, closed: false })),
      dots: ends.length ? ends : arms.map(mid),
      ...(ends.length === 3 && { measure: { at: vertexZyx, text: `${measure(degrees)}°` } }),
    };
  }
  const { outline } = mark;
  if (!outline.zyx.every(onSlice)) return null;
  return {
    lines: [{ points: outline.zyx, closed: true }],
    dots: [],
    measure: { at: mid(outline.zyx), text: `${measure(outline.areaMm2)} mm²` },
  };
}

/** The whole mark, for 3D. */
export function wholeShape(mark: GridMark): Shape {
  if ("point" in mark) {
    const text = pointText(mark);
    return { lines: [], dots: [mark.point], ...(text && { measure: { at: mark.point, text } }) };
  }
  if ("angle" in mark) {
    const { aZyx, vertexZyx, bZyx, degrees } = mark.angle;
    return {
      lines: [{ points: [aZyx, vertexZyx, bZyx], closed: false }],
      dots: [aZyx, vertexZyx, bZyx],
      measure: { at: vertexZyx, text: `${measure(degrees)}°` },
    };
  }
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
 * would land (`hover`).
 */
function drawMarks(
  canvas: HTMLCanvasElement,
  ink: Ink,
  { project, shapeOf, handles = [] }: MarkView,
  marks: readonly ShownMark[],
  draft: GridMark | null,
  hover: Zyx | null,
) {
  const ctx = canvas.getContext("2d")!;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!marks.length && !draft && !hover && !handles.length) return;
  // The scale the canvas was sized with, so a pixel-ratio change before the next resize can't skew it.
  const scale = canvas.width / (canvas.clientWidth || 1);
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.font = "11px ui-monospace, SFMono-Regular, Menlo, monospace";
  ctx.textBaseline = "middle";
  const shown: ShownMark[] = [...marks];
  if (draft) shown.push({ id: "", mark: draft, by: "you" });
  for (const m of shown) {
    const shape = shapeOf(m.mark);
    if (!shape) continue;
    const color = ink[m.by];
    const width = m.selected ? 3 : 2;
    // The selected mark's edge is light, not dark, so it stands out from the rest.
    const edge = m.selected ? ink.chipFg : ink.well;
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
      ctx.strokeStyle = edge;
      ctx.lineWidth = width + (m.selected ? 4 : 2);
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
      ctx.arc(p[0], p[1], m.selected ? 6 : 4, 0, 2 * Math.PI);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.strokeStyle = edge;
      ctx.lineWidth = m.selected ? 2 : 1.5;
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
      if (m.selected) {
        ctx.strokeStyle = edge;
        ctx.lineWidth = 2;
        ctx.strokeRect(x - 1, y - 9, w + 2, 18);
      }
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
  // Tilt handles: a ring in the plane's colour on a dark edge.
  for (const h of handles) {
    ctx.beginPath();
    ctx.arc(h.x, h.y, 5, 0, 2 * Math.PI);
    ctx.fillStyle = h.color;
    ctx.fill();
    ctx.strokeStyle = ink.well;
    ctx.lineWidth = 2;
    ctx.stroke();
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

/**
 * A mark's vertices in a fixed order: a point's one; a box's min, max; a line's a, b; an angle's
 * a, vertex, b; an outline's own.
 */
export function markPoints(mark: GridMark): readonly Zyx[] {
  if ("point" in mark) return [mark.point];
  if ("box" in mark) return [mark.box.min, mark.box.max];
  if ("line" in mark) return [mark.line.aZyx, mark.line.bZyx];
  if ("angle" in mark) return [mark.angle.aZyx, mark.angle.vertexZyx, mark.angle.bZyx];
  return mark.outline.zyx;
}

/** A voxel (z, y, x) in world mm (x, y, z) through a volume's 4x4 row-major affine. */
export function worldOf(p: Zyx, affine: readonly (readonly number[])[]): [number, number, number] {
  const [x, y, z] = [p[2], p[1], p[0]];
  const row = (r: number) =>
    affine[r]![0]! * x + affine[r]![1]! * y + affine[r]![2]! * z + affine[r]![3]!;
  return [row(0), row(1), row(2)];
}
