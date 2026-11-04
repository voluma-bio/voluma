/**
 * A slice pane's pointer, wheel and key gestures (`SlicePane.tsx`): left drag moves the crosshair,
 * the wheel (and a trackpad pinch) zooms at the pointer, Shift + wheel steps slices along the normal
 * (Jimmy, Nov 4: as in the 3D pane and maps), Shift, middle
 * or right drag pans, and a press on a tilt handle turns the other planes. With no marking tool,
 * Alt + left drag turns this pane's image about the crosshair like a dial (`onSpin`), and `,` / `.`
 * (`<` `>` unshifted) turn the pane under the pointer (else the focused one) 1° anticlockwise /
 * clockwise, 0.1° with Shift. With a marking tool,
 * left click or drag marks: Point a voxel, Box a drag's rectangle, Line a drag's two ends or two
 * clicks, Angle three clicks (the vertex second), Outline a freehand loop,
 * Probe reads the value under the pointer and keeps it as a point on click. Whatever the tool, a
 * drag that starts within `END_HIT_PX` of an end of an editable mark (`ShownMark.movable`: a point, a
 * line, an angle) or of a published ruler moves that end (`onEdit`); a click there goes to the tool
 * (places, probes, adds a line end), and with no tool picks the mark (`onPick`).
 */
import { type RefObject, useCallback, useEffect, useRef, useState } from "react";
import { angleAbout, type Basis, type Slab, unit, type Vec3 } from "./frame";
import {
  angleDegrees,
  areaMm2,
  lengthMm,
  type MarkLayer,
  markPoints,
  pathLengthMm,
  probeText,
  thin,
} from "./marks";
import {
  type Axis,
  type GridAnnotation,
  type GridMark,
  type GridScene,
  type MarkEdit,
  type MarkTool,
  type ProbeValue,
  planeAxes,
  type ShownMark,
  type Zyx,
} from "./scene";

/** Pixels per mm, the zoom that fits the grid in the pane, and the pane centre in mm. */
export type PaneCamera = { zoom: number; fit: number; center: [number, number] };

/** What a probe reads at a source voxel, from what the pane has loaded. */
export type Probe = (p: Zyx) => ProbeValue | null;

/** The pane's props and frame as of the last render, read by the gestures as they happen. */
export type GestureInputs = {
  point: Zyx;
  onPoint(point: Zyx): void;
  tool: MarkTool | null;
  onMark(mark: GridMark): void;
  onTilt?(angle: number): void;
  /** Turns this pane's image by `angle` radians clockwise on screen; absent, it can't be. */
  onSpin?(angle: number): void;
  toPane(p: Zyx): [number, number];
  fromPane(x: number, y: number, at: Zyx): Zyx;
  basis: Basis;
  whole: boolean;
  /** What lies on the pane's slice: |slab| ≤ ½. */
  slab: Slab;
  marks: readonly ShownMark[];
  /** The published annotations shown; a ruler's ends can be dragged. */
  annotations: readonly GridAnnotation[];
  /** An end dragged; absent, no end can be. */
  onEdit?(edit: MarkEdit): void;
  /** A mark's end clicked without moving, or no mark on a navigation click. */
  onPick?(id?: string): void;
};

/** A drag shorter than this (CSS px) is a click. */
const CLICK_PX = 4;
/** An outline or a path takes a point when the pointer has moved this far (CSS px) since the last. */
const OUTLINE_STEP_PX = 3;
/** The cap on an outline's or a path's points (the task loop's contract caps an outline at 500). */
const OUTLINE_MAX = 500;
/** How near a tilt handle a press must land (CSS px). */
const HANDLE_HIT_PX = 9;
/** Within this distance of the crosshair (CSS px) a spin drag's angle is too unsteady to follow. */
const SPIN_STILL_PX = 12;
/** What `,` and `.` turn by, in degrees; with Shift, the fine step. */
const SPIN_KEY_DEGREES = 1;
const SPIN_FINE_DEGREES = 0.1;
/** How near a mark's end a press must land to drag it (CSS px), whatever the zoom: the dot drawn is smaller. */
const END_HIT_PX = 10;

/** A mark or ruler end under the pointer: which vertex of which mark. */
type End = { from: MarkEdit["from"]; id: string; mark: GridMark; index: number };

/** `mark` with vertex `index` at `p`, its measure recomputed. */
function withEnd(mark: GridMark, index: number, p: Zyx, spacingZyx: Zyx): GridMark {
  if ("point" in mark) return { ...mark, point: p };
  if ("line" in mark) {
    const [a, b] = index === 0 ? [p, mark.line.bZyx] : [mark.line.aZyx, p];
    return { line: { aZyx: a, bZyx: b, lengthMm: lengthMm(a, b, spacingZyx) } };
  }
  if ("angle" in mark) {
    const ends = [mark.angle.aZyx, mark.angle.vertexZyx, mark.angle.bZyx];
    ends[index] = p;
    const [a, v, b] = ends as [Zyx, Zyx, Zyx];
    return {
      angle: { aZyx: a, vertexZyx: v, bZyx: b, degrees: angleDegrees(a, v, b, spacingZyx) },
    };
  }
  return mark;
}

/** The ends a press can take: a point's voxel (not a probe's), a line's two, an angle's three. */
function endsOf(mark: GridMark): readonly Zyx[] {
  const probe = "point" in mark && mark.probe;
  return probe || "box" in mark || "outline" in mark || "path" in mark ? [] : markPoints(mark);
}

/**
 * Binds the gestures to `host` once, for the pane's life: the grid, `axis` and the callbacks are
 * the first render's (the viewer remounts on a new grid). Returns the probe's readout and whether
 * the pointer is over the pane.
 */
export function useSliceGestures(args: {
  host: RefObject<HTMLDivElement | null>;
  view: RefObject<PaneCamera | null>;
  render(): void;
  layer: MarkLayer;
  latest: RefObject<GestureInputs>;
  probe: RefObject<Probe | null>;
  scene: GridScene;
  axis: Axis;
  /** The tilt handles in CSS px, for a pane `width` × `height`. */
  handlesNow(width: number, height: number): readonly { x: number; y: number }[];
  /** Picks the level the zoom needs, after a zoom. */
  pickLevel(): void;
}) {
  const { host, view, layer, latest, probe } = args;
  const first = useRef(args);
  const tool = latest.current.tool;
  // `x` from the pane's left, or (`left` false: the pointer is in its right half) its right.
  const [readout, setReadout] = useState<{
    x: number;
    y: number;
    left: boolean;
    text: string;
  } | null>(null);
  const [hovering, setHovering] = useState(false);
  // An untilted pane steps whole slices; a tilted one steps the finest spacing along its normal.
  const step = useCallback(
    (by: number) => {
      const { scene, axis } = first.current;
      const { point: at, whole: w, basis: b } = latest.current;
      const p = [...at];
      if (w) p[axis] = clamp(Math.round(p[axis]!) + by, scene.shapeZyx[axis]);
      else {
        const h = Math.min(...scene.spacingZyx) * by;
        for (const k of [0, 1, 2]) p[k] = p[k]! + (h * b.normal[k]!) / scene.spacingZyx[k]!;
        if (p.some((v, k) => v < 0 || v > scene.shapeZyx[k]! - 1)) return;
      }
      latest.current.onPoint(p as unknown as Zyx);
    },
    [latest],
  );

  useEffect(() => {
    const element = host.current!;
    const { scene, axis, handlesNow, pickLevel, render } = first.current;
    const [ra, ca] = planeAxes(axis);
    const paneMm = (event: { clientX: number; clientY: number }) => {
      const rect = element.getBoundingClientRect();
      const v = view.current!;
      return [
        v.center[0] + (event.clientX - rect.left - rect.width / 2) / v.zoom,
        v.center[1] - (event.clientY - rect.top - rect.height / 2) / v.zoom,
      ] as const;
    };
    const inside = (p: readonly number[]) =>
      p.map((v, k) => Math.max(0, Math.min(scene.shapeZyx[k]! - 1, v))) as unknown as Zyx;
    // The voxel under the pointer on this slice: an untilted pane keeps the crosshair's own value
    // across the slice, so moving in one pane never changes its slice.
    const toVoxel = (event: { clientX: number; clientY: number }): Zyx => {
      const [x, y] = paneMm(event);
      const { point: at, fromPane: from, whole: w } = latest.current;
      const p = from(x, y, at);
      if (!w) return inside(p);
      const q = [...at];
      q[ca] = clamp(Math.round(p[ca]), scene.shapeZyx[ca]);
      q[ra] = clamp(Math.round(p[ra]), scene.shapeZyx[ra]);
      return q as unknown as Zyx;
    };
    // Where the pointer is on the slice through `at` (by default the crosshair), between voxel
    // centres: a line's or an outline's points.
    const toPosition = (
      event: { clientX: number; clientY: number },
      at: Zyx = latest.current.point,
    ): Zyx => {
      const [x, y] = paneMm(event);
      const { fromPane: from, whole: w } = latest.current;
      const p = inside(from(x, y, at)).map(hundredths);
      if (w) p[axis] = Math.round(at[axis]);
      return p as unknown as Zyx;
    };
    // Clicks made so far toward a line (two) or an angle (three); the layer's draft shows them.
    let clicks: Zyx[] = [];
    // The editable end nearest the pointer on this slice, within `END_HIT_PX`: your marks first,
    // so a ruler you already moved drags as yours.
    // Box, Outline and Probe never grab: a press there always draws or reads.
    const endAt = (event: { clientX: number; clientY: number }): End | null => {
      const { onEdit, marks, annotations, slab, toPane: tp, tool: now } = latest.current;
      const v = view.current;
      if (!onEdit || !v) return null;
      if (now && now !== "point" && now !== "line" && now !== "angle") return null;
      const rect = element.getBoundingClientRect();
      const px = (p: Zyx) => {
        const [x, y] = tp(p);
        return [
          (x - v.center[0]) * v.zoom + rect.width / 2,
          (v.center[1] - y) * v.zoom + rect.height / 2,
        ] as const;
      };
      const candidates: Omit<End, "index">[] = [
        ...marks.filter((m) => m.movable).map((m) => ({ from: "mark" as const, ...m })),
        ...annotations
          .filter((a) => a.points.length === 2)
          .map((a) => {
            const [p, q] = a.points as [Zyx, Zyx];
            return {
              from: "annotation" as const,
              id: a.id,
              mark: { line: { aZyx: p, bZyx: q, lengthMm: lengthMm(p, q, scene.spacingZyx) } },
            };
          }),
      ];
      const pointer = [event.clientX - rect.left, event.clientY - rect.top] as const;
      for (const c of candidates) {
        const index = endsOf(c.mark).findIndex((p) => {
          if (Math.abs(slab(p)) > 0.5) return false;
          const [x, y] = px(p);
          return Math.hypot(x - pointer[0], y - pointer[1]) <= END_HIT_PX;
        });
        if (index >= 0) return { from: c.from, id: c.id, mark: c.mark, index };
      }
      return null;
    };
    // The gesture's pointer is the mark layer's; the rest of it is the pane's.
    let drag: {
      mode: "cross" | "pan" | "tilt" | "spin" | "end" | MarkTool;
      x: number;
      y: number;
      /** The crosshair at press: a drawn mark stays on its slice if the wheel steps mid-drag. */
      at: Zyx;
      from: Zyx;
      moved: boolean;
      /** An outline's or a path's points, and the screen position of the last. */
      path: Zyx[];
      last: [number, number];
      /** A tilt's direction from the crosshair, in mm, at the last move. */
      toward?: Vec3;
      /**
       * A spin's crosshair in client px (it stays put as the image turns about it) and the
       * pointer's screen angle about it at the last move.
       */
      dial?: { x: number; y: number; angle: number | null };
      /** The end being dragged. */
      end?: End;
    } | null = null;
    const stopReset = layer.onCancel(() => {
      drag = null;
      clicks = [];
    });
    /** The direction from the crosshair to the pointer, in the grid's mm, on this plane. */
    const towardPointer = (event: PointerEvent): Vec3 => {
      const [x, y] = paneMm(event);
      const { point: at, toPane: tp, basis: b } = latest.current;
      const [cxMm, cyMm] = tp(at);
      return unit(
        [0, 1, 2].map((k) => (x - cxMm) * b.right[k]! - (y - cyMm) * b.down[k]!) as unknown as Vec3,
      );
    };
    // The draft of a mark made by clicks, its last end at `to`.
    const clickDraft = (tool: MarkTool, to: Zyx): GridMark | null => {
      const sp = scene.spacingZyx;
      if (tool === "line" && clicks.length === 1)
        return { line: { aZyx: clicks[0]!, bZyx: to, lengthMm: lengthMm(clicks[0]!, to, sp) } };
      if (tool === "angle" && clicks.length === 1)
        return { line: { aZyx: clicks[0]!, bZyx: to, lengthMm: lengthMm(clicks[0]!, to, sp) } };
      if (tool === "angle" && clicks.length === 2)
        return {
          angle: {
            aZyx: clicks[0]!,
            vertexZyx: clicks[1]!,
            bZyx: to,
            degrees: angleDegrees(clicks[0]!, clicks[1]!, to, sp),
          },
        };
      return null;
    };
    /** The crosshair in client px. */
    const crosshairPx = () => {
      const rect = element.getBoundingClientRect();
      const v = view.current!;
      const [x, y] = latest.current.toPane(latest.current.point);
      return {
        x: rect.left + rect.width / 2 + (x - v.center[0]) * v.zoom,
        y: rect.top + rect.height / 2 + (v.center[1] - y) * v.zoom,
      };
    };
    /** The pointer's screen angle about the dial's centre, clockwise; null too near it. */
    const dialAngle = (event: PointerEvent, at: { x: number; y: number }) => {
      const dx = event.clientX - at.x;
      const dy = event.clientY - at.y;
      return Math.hypot(dx, dy) < SPIN_STILL_PX ? null : Math.atan2(dy, dx);
    };
    const down = (event: PointerEvent) => {
      if ((event.target as HTMLElement).closest("button, input, textarea, select, a")) return;
      if (drag || !view.current) return;
      element.focus({ preventScroll: true });
      const pan = event.button === 1 || event.button === 2 || event.shiftKey;
      const tool = latest.current.tool;
      const spin = !pan && !tool && event.altKey && !!latest.current.onSpin;
      // A press on a tilt handle turns the other planes.
      const rect = element.getBoundingClientRect();
      const hit =
        !pan && !spin && !tool && latest.current.onTilt
          ? handlesNow(rect.width, rect.height).find(
              (h) =>
                Math.hypot(h.x - (event.clientX - rect.left), h.y - (event.clientY - rect.top)) <=
                HANDLE_HIT_PX,
            )
          : undefined;
      // Mid-way through a click-made line or angle, a press adds its next end, even on an old one.
      // Under a tool the end is only a candidate: `move` makes it a drag once the pointer leaves.
      const end = !pan && !spin && !hit && !clicks.length ? endAt(event) : null;
      layer.start(event);
      const from = toPosition(event);
      const centre = spin ? crosshairPx() : null;
      drag = {
        mode: pan ? "pan" : spin ? "spin" : hit ? "tilt" : end && !tool ? "end" : (tool ?? "cross"),
        x: event.clientX,
        y: event.clientY,
        at: latest.current.point,
        from,
        moved: false,
        path: [from],
        last: [event.clientX, event.clientY],
        ...(hit && { toward: towardPointer(event) }),
        ...(centre && { dial: { ...centre, angle: dialAngle(event, centre) } }),
        ...(end && { end }),
      };
      if (drag.mode === "cross") latest.current.onPoint(toVoxel(event));
    };
    const move = (event: PointerEvent) => {
      const tool = latest.current.tool;
      if (!drag) {
        if (latest.current.onEdit)
          element.style.cursor = !clicks.length && endAt(event) ? "grab" : "";
        if (tool === "point" || tool === "line" || tool === "angle") {
          layer.hover = toVoxel(event);
          if (clicks.length) layer.draft = clickDraft(tool, toPosition(event));
          layer.redraw();
        }
        if (tool === "probe") showProbe(event);
        return;
      }
      if (!layer.owns(event)) return;
      if (drag.mode === "cross") {
        if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) >= CLICK_PX)
          drag.moved = true;
        latest.current.onPoint(toVoxel(event));
      } else if (drag.mode === "tilt") {
        const toward = towardPointer(event);
        const angle = angleAbout(drag.toward!, toward, latest.current.basis.normal);
        drag.toward = toward;
        if (angle) latest.current.onTilt?.(angle);
      } else if (drag.mode === "spin") {
        const dial = drag.dial!;
        const angle = dialAngle(event, dial);
        if (angle === null) return;
        if (dial.angle !== null) {
          // The change across ±π, the short way round.
          const by = Math.atan2(Math.sin(angle - dial.angle), Math.cos(angle - dial.angle));
          if (by) latest.current.onSpin?.(by);
        }
        dial.angle = angle;
      } else if (drag.mode !== "pan") {
        if (!drag.moved && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < CLICK_PX)
          return;
        drag.moved = true;
        // Under a tool, a press near an end is settled on release: past the threshold it is an end
        // drag; a click goes to the tool.
        if (drag.end && drag.mode !== "end") {
          drag.mode = "end";
          layer.hover = null;
        }
        // On the slice the gesture began on, even if the wheel stepped since.
        const to = toPosition(event, drag.at);
        if (drag.mode === "end") {
          const { end } = drag;
          // A point stays on a voxel, as Point makes it.
          const p = end && "point" in end.mark ? round(toVoxel(event)) : to;
          layer.draft = end ? withEnd(end.mark, end.index, p, scene.spacingZyx) : null;
          element.style.cursor = "grabbing";
        } else if (drag.mode === "box") layer.draft = boxMark(round(drag.from), round(to));
        else if (drag.mode === "line" && !clicks.length) {
          layer.hover = null;
          layer.draft = {
            line: {
              aZyx: [...drag.from],
              bZyx: [...to],
              lengthMm: lengthMm(drag.from, to, scene.spacingZyx),
            },
          };
        } else if (drag.mode === "outline" || drag.mode === "path") {
          if (
            Math.hypot(event.clientX - drag.last[0], event.clientY - drag.last[1]) < OUTLINE_STEP_PX
          )
            return;
          drag.last = [event.clientX, event.clientY];
          drag.path.push(to);
          const zyx = drag.path.map((p) => [...p] as unknown as Zyx);
          layer.draft =
            drag.mode === "path"
              ? { path: { zyx, lengthMm: pathLengthMm(zyx, scene.spacingZyx) } }
              : { outline: { zyx, areaMm2: areaMm2(zyx, scene.spacingZyx) } };
        }
        layer.redraw();
      } else {
        const v = view.current!;
        v.center = [
          v.center[0] - (event.clientX - drag.x) / v.zoom,
          v.center[1] + (event.clientY - drag.y) / v.zoom,
        ];
        drag.x = event.clientX;
        drag.y = event.clientY;
        render();
      }
    };
    const up = (event: PointerEvent) => {
      if (!drag || !layer.owns(event)) return;
      move(event);
      const d = drag;
      if (d.mode === "end") {
        const made = layer.draft;
        layer.cancel();
        element.style.cursor = "";
        const { end } = d;
        if (!end) return;
        if (d.moved && made) latest.current.onEdit?.({ from: end.from, id: end.id, mark: made });
        else if (!d.moved && end.from === "mark") latest.current.onPick?.(end.id);
        return;
      }
      if (d.mode === "cross" && !d.moved) latest.current.onPick?.(undefined);
      // A click toward a line or an angle: keep going until the mark has all its ends.
      if ((d.mode === "line" && (!d.moved || clicks.length)) || d.mode === "angle") {
        clicks.push(toPosition(event));
        const [a, b, c] = clicks;
        const sp = scene.spacingZyx;
        const made: GridMark | null =
          d.mode === "line"
            ? b
              ? { line: { aZyx: a!, bZyx: b, lengthMm: lengthMm(a!, b, sp) } }
              : null
            : c
              ? {
                  angle: { aZyx: a!, vertexZyx: b!, bZyx: c, degrees: angleDegrees(a!, b!, c, sp) },
                }
              : null;
        if (!made) {
          drag = null;
          layer.release();
          layer.draft = clickDraft(d.mode, clicks.at(-1)!);
          layer.redraw();
          return;
        }
        layer.cancel();
        if (!("line" in made) || made.line.lengthMm > 0) latest.current.onMark(made);
        return;
      }
      const made = finish(d, event);
      layer.cancel();
      if (!made) return;
      latest.current.onMark(made);
      // A point moves the crosshair to it, so every pane shows it.
      if ("point" in made) latest.current.onPoint(made.point);
    };
    // The mark a finished gesture makes, if any: a click marks only with Point and Probe.
    const finish = (d: NonNullable<typeof drag>, event: PointerEvent): GridMark | null => {
      if (
        d.mode === "cross" ||
        d.mode === "pan" ||
        d.mode === "tilt" ||
        d.mode === "spin" ||
        d.mode === "end"
      )
        return null;
      if (d.mode === "point")
        return d.moved ? null : { point: [...round(d.from)] as unknown as Zyx };
      if (d.mode === "probe") {
        if (d.moved) return null;
        const at = round(toVoxel(event));
        const read = probe.current?.(at);
        return read ? { point: at, probe: read } : null;
      }
      const made = layer.draft;
      if (made && "line" in made && made.line.lengthMm > 0) return made;
      if (made && "box" in made) return made;
      if (made && "outline" in made) {
        const zyx = thin(made.outline.zyx, OUTLINE_MAX);
        const area = areaMm2(zyx, scene.spacingZyx);
        if (zyx.length >= 3 && area > 0) return { outline: { zyx, areaMm2: area } };
      }
      if (made && "path" in made) {
        // Thinned with its last point kept: an open line ends where it was drawn to.
        const all = made.path.zyx;
        const zyx = [...thin(all.slice(0, -1), OUTLINE_MAX - 1), all[all.length - 1]!];
        const length = pathLengthMm(zyx, scene.spacingZyx);
        if (zyx.length >= 2 && length > 0) return { path: { zyx, lengthMm: length } };
      }
      return null;
    };
    const showProbe = (event: PointerEvent) => {
      const rect = element.getBoundingClientRect();
      const at = round(toVoxel(event));
      const read = probe.current?.(at);
      setReadout(
        read
          ? {
              ...(event.clientX - rect.left < rect.width / 2
                ? { x: event.clientX - rect.left, left: true }
                : { x: rect.right - event.clientX, left: false }),
              y: event.clientY - rect.top,
              text: [
                probeText(read),
                `x ${at[2]} y ${at[1]} z ${at[0]}`,
                ...(read.inside.length ? [`in ${read.inside.join(", ")}`] : []),
              ].join("  ·  "),
            }
          : null,
      );
    };
    const enter = () => setHovering(true);
    const leave = () => {
      setHovering(false);
      setReadout(null);
      if (!layer.hover) return;
      layer.hover = null;
      layer.redraw();
    };
    // A box dragged on one slice spans that slice's two axes; across the held axis it takes the
    // smaller of the two dragged sides in mm, centred on the slice, so it reads as a region.
    const boxMark = (a: Zyx, b: Zyx): GridMark => {
      const sr = scene.spacingZyx[ra];
      const sc = scene.spacingZyx[ca];
      const min = [0, 0, 0];
      const max = [0, 0, 0];
      for (const i of [ra, ca]) {
        min[i] = Math.min(a[i], b[i]);
        max[i] = Math.max(a[i], b[i]);
      }
      const depthMm = Math.min((max[ra]! - min[ra]! + 1) * sr, (max[ca]! - min[ca]! + 1) * sc);
      const half = Math.floor(depthMm / scene.spacingZyx[axis] / 2);
      min[axis] = clamp(a[axis] - half, scene.shapeZyx[axis]);
      max[axis] = clamp(a[axis] + half, scene.shapeZyx[axis]);
      return {
        box: { min: min as unknown as Zyx, max: max as unknown as Zyx },
      };
    };
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      // Shift + wheel steps slices (some browsers turn Shift + wheel into a sideways scroll).
      if (event.shiftKey) {
        const by = event.deltaY || event.deltaX;
        if (by !== 0) step(Math.sign(by));
        return;
      }
      const v = view.current!;
      const rect = element.getBoundingClientRect();
      const dx = event.clientX - rect.left - rect.width / 2;
      const dy = event.clientY - rect.top - rect.height / 2;
      const before = [v.center[0] + dx / v.zoom, v.center[1] - dy / v.zoom];
      v.zoom = Math.min(v.fit * 64, Math.max(v.fit / 2, v.zoom * Math.exp(-event.deltaY * 0.002)));
      v.center = [before[0]! - dx / v.zoom, before[1]! + dy / v.zoom];
      render();
      pickLevel();
    };
    const key = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        event.target !== element
      )
        return;
      const by = { ArrowUp: -1, ArrowDown: 1, PageUp: -10, PageDown: 10 }[event.key];
      if (by === undefined) return;
      event.preventDefault();
      step(by);
    };
    // `,` and `.` go to the pane under the pointer, else the focused one, so turning needs no click.
    // By `code`, so Shift (`<`, `>` on US keys) and other layouts keep them. (`]` is the shell's.)
    const spinKey = (event: KeyboardEvent) => {
      const by = { Comma: -1, Period: 1 }[event.code];
      const { onSpin } = latest.current;
      if (by === undefined || !onSpin || event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.defaultPrevented || event.isComposing) return;
      const target = event.target as Element;
      // Typing, or a key meant for an open dialog or menu, never turns a pane behind it.
      if (
        target.closest?.(
          "input, textarea, select, [contenteditable], dialog, [role='dialog'], [role='menu']",
        )
      )
        return;
      const owner =
        document.querySelector("[data-slice-pane]:hover") ?? target.closest?.("[data-slice-pane]");
      if (owner !== element) return;
      event.preventDefault();
      const degrees = event.shiftKey ? SPIN_FINE_DEGREES : SPIN_KEY_DEGREES;
      onSpin((by * degrees * Math.PI) / 180);
    };
    const menu = (event: Event) => event.preventDefault();
    element.addEventListener("pointerdown", down);
    element.addEventListener("pointermove", move);
    element.addEventListener("pointerup", up);
    element.addEventListener("pointerenter", enter);
    element.addEventListener("pointerleave", leave);
    element.addEventListener("wheel", wheel, { passive: false });
    element.addEventListener("keydown", key);
    // Capture: ahead of the page's own window shortcuts, whatever order they were added in.
    globalThis.addEventListener("keydown", spinKey, true);
    element.addEventListener("contextmenu", menu);
    return () => {
      stopReset();
      element.removeEventListener("pointerdown", down);
      element.removeEventListener("pointermove", move);
      element.removeEventListener("pointerup", up);
      element.removeEventListener("pointerenter", enter);
      element.removeEventListener("pointerleave", leave);
      element.removeEventListener("wheel", wheel);
      element.removeEventListener("keydown", key);
      globalThis.removeEventListener("keydown", spinKey, true);
      element.removeEventListener("contextmenu", menu);
    };
  }, []);
  useEffect(() => {
    if (tool !== "probe") setReadout(null);
  }, [tool]);
  return { readout, hovering, step };
}

const clamp = (n: number, size: number) => Math.max(0, Math.min(size - 1, n));
const round = (p: Zyx) => p.map(Math.round) as unknown as Zyx;
/** A position to 0.01 voxel: finer says nothing and only lengthens the message. */
const hundredths = (n: number) => Math.round(n * 100) / 100;
