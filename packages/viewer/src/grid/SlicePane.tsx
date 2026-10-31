/**
 * One slice pane of the grid viewer: the plane through the crosshair that holds `axis`
 * constant, drawn by three.js with an orthographic camera in mm. It opens on the coarsest
 * level and refines to the level the zoom needs. Left drag moves the crosshair, the wheel
 * steps slices, Ctrl or ⌘ + wheel zooms at the pointer, Shift, middle or right drag pans.
 *
 * With a marking tool, left click or drag marks instead (`marks.ts` draws them): Point a voxel
 * (and the crosshair moves to it), Box a drag's rectangle, Line a drag's two ends, Outline a
 * freehand loop. Esc drops a mark being drawn.
 */
import { cx } from "@voluma/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  BufferGeometry,
  CircleGeometry,
  Float32BufferAttribute,
  Group,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  OrthographicCamera,
  Scene,
  WebGLRenderer,
} from "three";
import { type Contrast, compose, type OverlayPlane } from "./compose";
import { loadMesh, sliceSegment, surfaceTrace } from "./geometry";
import { areaMm2, lengthMm, sliceShape, thin, useMarkLayer } from "./marks";
import { CHIP, PANE } from "./pane-style";
import { corners, type Picture, quad, texture } from "./picture";
import { readPlane } from "./planes";
import {
  type Axis,
  capturePane,
  type GridMark,
  type GridScene,
  levelFor,
  levelIndex,
  type MarkTool,
  type PaneHandle,
  type PaneStatus,
  type PaneView,
  planeAxes,
  type ShownMark,
  type Zyx,
} from "./scene";
import { tokenColor } from "./token-color";

export const axisColor = (axis: Axis) =>
  tokenColor(axis === 0 ? "--axis-z" : axis === 1 ? "--axis-y" : "--axis-x");

/** Pixels per mm, the zoom that fits the grid in the pane, and the pane centre in mm. */
type View = { zoom: number; fit: number; center: [number, number] };

/** A drag shorter than this (CSS px) is a click. */
const CLICK_PX = 4;
/** An outline takes a point when the pointer has moved this far (CSS px) since the last. */
const OUTLINE_STEP_PX = 3;
/** The contract's cap on an outline's points. */
const OUTLINE_MAX = 500;

export function SlicePane({
  axis,
  scene,
  point,
  onPoint,
  contrast,
  handle,
  onStatus,
  tool,
  marks,
  onMark,
}: {
  axis: Axis;
  scene: GridScene;
  point: Zyx;
  onPoint(point: Zyx): void;
  contrast: Contrast | null;
  /** What a left click or drag makes; none moves the crosshair. */
  tool: MarkTool | null;
  marks: readonly ShownMark[];
  onMark(mark: GridMark): void;
  /** Set while the pane is mounted, for screenshots. */
  handle: { current: PaneHandle | null };
  onStatus(status: PaneStatus): void;
}) {
  const [ra, ca] = planeAxes(axis);
  const sr = scene.spacingZyx[ra];
  const sc = scene.spacingZyx[ca];
  const host = useRef<HTMLDivElement>(null);
  const three = useRef<{
    renderer: WebGLRenderer;
    camera: OrthographicCamera;
    scene: Scene;
    image: Mesh<BufferGeometry, MeshBasicMaterial>;
    cross: LineSegments<BufferGeometry, LineBasicMaterial>;
    drawings: Group;
    render(): void;
  } | null>(null);
  const view = useRef<View | null>(null);
  // A saved view shown before the pane had a size: applied when it gets one.
  const pending = useRef<{ zoom: number; center: [number, number] } | null>(null);
  const [level, setLevel] = useState(scene.image.levels.length - 1);
  const [shown, setShown] = useState<{
    level: number;
    index: number;
    contrast: Contrast;
    overlays: GridScene["overlays"];
  } | null>(null);
  const [error, setError] = useState<string>();
  const [traceError, setTraceError] = useState<string>();
  const [traces, setTraces] = useState<Map<string, BufferGeometry>>(new Map());
  const latest = useRef({ point, onPoint, onStatus, tool, marks, onMark });
  latest.current = { point, onPoint, onStatus, tool, marks, onMark };

  // Pane mm: columns run right, rows run down.
  const toPane = (p: Zyx): [number, number] => [p[ca] * sc, -p[ra] * sr];

  const layer = useMarkLayer(
    host,
    () => {
      const v = view.current;
      const canvas = host.current;
      if (!v || !canvas) return null;
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      const at = latest.current.point[axis];
      return {
        project: (p) => {
          const [x, y] = toPane(p);
          return [(x - v.center[0]) * v.zoom + width / 2, (v.center[1] - y) * v.zoom + height / 2];
        },
        shapeOf: (mark) => sliceShape(mark, axis, at),
      };
    },
    tool,
    marks,
  );

  // The renderer lives as long as the pane; resizing only changes its size.
  useEffect(() => {
    const element = host.current!;
    const renderer = new WebGLRenderer({ antialias: false });
    renderer.setPixelRatio(globalThis.devicePixelRatio);
    renderer.setClearColor(tokenColor("--viewer-well"));
    element.append(renderer.domElement);
    renderer.domElement.className = "absolute inset-0";
    const camera = new OrthographicCamera(-1, 1, 1, -1, -10, 10);
    const s = new Scene();
    const image = new Mesh(new BufferGeometry(), new MeshBasicMaterial());
    const cross = new LineSegments(
      new BufferGeometry(),
      new LineBasicMaterial({ vertexColors: true, depthTest: false }),
    );
    cross.renderOrder = 1;
    const drawings = new Group();
    s.add(image, cross, drawings);
    const state = {
      renderer,
      camera,
      scene: s,
      image,
      cross,
      drawings,
      // One frame per animation frame, however many changes asked for it.
      render() {
        frame ||= requestAnimationFrame(paint);
      },
    };
    let frame = 0;
    const paint = () => {
      frame = 0;
      const { width, height } = element.getBoundingClientRect();
      const v = view.current;
      if (!width || !height || !v) return;
      camera.left = v.center[0] - width / 2 / v.zoom;
      camera.right = v.center[0] + width / 2 / v.zoom;
      camera.top = v.center[1] + height / 2 / v.zoom;
      camera.bottom = v.center[1] - height / 2 / v.zoom;
      camera.updateProjectionMatrix();
      renderer.render(s, camera);
      layer.draw();
    };
    const fitZoom = (width: number, height: number) =>
      Math.min(width / (scene.shapeZyx[ca] * sc), height / (scene.shapeZyx[ra] * sr)) * 0.95;
    three.current = state;
    handle.current = {
      capture() {
        const v = view.current!;
        return {
          ...capturePane(renderer.domElement, paint),
          view: { zoom: v.zoom / v.fit, center: [v.center[0], v.center[1]] },
        };
      },
      layers: () => layer.layers(renderer.domElement, paint),
      show(saved: PaneView) {
        if (!("zoom" in saved)) return;
        if (!view.current) {
          pending.current = saved;
          return;
        }
        view.current.zoom = saved.zoom * view.current.fit;
        view.current.center = [saved.center[0], saved.center[1]];
        state.render();
        pickLevel();
      },
    };
    const observer = new ResizeObserver(() => {
      const { width, height } = element.getBoundingClientRect();
      if (!width || !height) return;
      renderer.setSize(width, height);
      // Keep the framing when the pane resizes or maximizes: zoom is relative to the fit.
      const fitted = fitZoom(width, height);
      if (view.current) view.current.zoom *= fitted / view.current.fit;
      view.current ??= {
        zoom: fitted * (pending.current?.zoom ?? 1),
        fit: fitted,
        center: pending.current?.center ?? [
          (scene.shapeZyx[ca] * sc) / 2,
          (-scene.shapeZyx[ra] * sr) / 2,
        ],
      };
      view.current.fit = fitted;
      state.render();
      pickLevel();
    });
    observer.observe(element);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      image.geometry.dispose();
      image.material.map?.dispose();
      image.material.dispose();
      cross.geometry.dispose();
      cross.material.dispose();
      renderer.forceContextLoss();
      renderer.dispose();
      renderer.domElement.remove();
      three.current = null;
      handle.current = null;
    };
    // Runs once: the scene's grid is fixed for the pane's life (the viewer remounts on a new grid).
  }, []);

  const traceMeshes = scene.meshes.filter((m) => m.trace);
  const traceKey = traceMeshes.map((m) => m.id).join("\n");
  const latestTraces = useRef(traceMeshes);
  latestTraces.current = traceMeshes;
  useEffect(() => {
    const abort = new AbortController();
    const loaded = new Map<string, BufferGeometry>();
    setTraces(new Map());
    setTraceError(undefined);
    Promise.all(
      latestTraces.current.map(async (m) => {
        const geometry = await loadMesh(m, abort.signal);
        if (abort.signal.aborted) geometry.dispose();
        else {
          loaded.set(m.id, geometry);
          setTraces(new Map(loaded));
        }
      }),
    ).catch((cause) => {
      if (!abort.signal.aborted)
        setTraceError(`Couldn't load surface traces: ${(cause as Error).message}`);
    });
    return () => {
      abort.abort();
      for (const geometry of loaded.values()) geometry.dispose();
    };
  }, [traceKey]);

  // Display changes only repaint the traces; intersect the triangles again only on a new plane
  // or geometry. Review rebuilds the mesh objects even when only a ruler's opacity changes.
  const traceLayout = traceMeshes.map((m) => `${m.id}:${m.offsetZyx.join(",")}`).join("\n");
  const traceSegments = useMemo(
    () =>
      new Map(
        latestTraces.current.map((m) => {
          const geometry = traces.get(m.id);
          return [m.id, geometry ? surfaceTrace(geometry, axis, point[axis], m.offsetZyx) : []];
        }),
      ),
    [traces, traceLayout, point[axis]],
  );

  useEffect(() => {
    const t = three.current;
    if (!t) return;
    const objects: (
      | Mesh<CircleGeometry, MeshBasicMaterial>
      | LineSegments<BufferGeometry, LineBasicMaterial>
    )[] = [];
    const line = (points: readonly Zyx[], color: string, opacity: number) => {
      if (!points.length || opacity <= 0) return;
      const geometry = new BufferGeometry();
      geometry.setAttribute(
        "position",
        new Float32BufferAttribute(
          points.flatMap((p) => [...toPane(p), 2]),
          3,
        ),
      );
      const object = new LineSegments(
        geometry,
        new LineBasicMaterial({ color, opacity, transparent: opacity < 1, depthTest: false }),
      );
      object.renderOrder = 2;
      objects.push(object);
    };
    for (const m of traceMeshes) line(traceSegments.get(m.id) ?? [], m.color, m.opacity);
    for (const a of scene.annotations) {
      if (a.opacity <= 0) continue;
      let dots = [...a.points];
      if (a.points.length === 2) {
        const segment = sliceSegment(a.points[0]!, a.points[1]!, axis, point[axis]);
        if (segment) {
          line(segment, a.color, a.opacity);
          // A ruler crossing perpendicular to the pane projects to a point, not a visible line.
          const [p, q] = segment;
          if (Math.hypot((p[ra] - q[ra]) * sr, (p[ca] - q[ca]) * sc) < Math.min(sr, sc)) dots = [p];
        }
      }
      for (const p of dots) {
        if (Math.abs(p[axis] - point[axis]) > 0.5) continue;
        const dot = new Mesh(
          new CircleGeometry(Math.max(sr, sc) * 2, 12),
          new MeshBasicMaterial({
            color: a.color,
            opacity: a.opacity,
            transparent: a.opacity < 1,
            depthTest: false,
          }),
        );
        dot.position.set(...toPane(p), 2);
        dot.renderOrder = 2;
        objects.push(dot);
      }
    }
    // add() with nothing logs an error.
    if (objects.length) t.drawings.add(...objects);
    t.render();
    return () => {
      for (const object of objects) {
        t.drawings.remove(object);
        object.geometry.dispose();
        object.material.dispose();
      }
    };
  }, [point[axis], scene.annotations, scene.meshes, traceSegments]);

  /** The level that gives each device pixel at least one voxel at the current zoom. */
  function pickLevel() {
    const v = view.current;
    if (!v) return;
    const mmPerPixel = 1 / (v.zoom * globalThis.devicePixelRatio);
    setLevel(levelFor(scene.image.levels, mmPerPixel / Math.min(sr, sc)));
  }

  // Load the plane through the crosshair at the level the zoom needs. The coarsest level shows
  // meanwhile, unless the finer one arrives almost as soon (it does from the worker's cache).
  const index = point[axis];
  useEffect(() => {
    if (!contrast) return;
    const abort = new AbortController();
    const load = async (k: number): Promise<Picture | null> => {
      const lvl = scene.image.levels[k]!;
      const s = lvl.scaleZyx[axis];
      const at = levelIndex(index, 0, s, lvl.shapeZyx[axis]);
      // Overlays are sampled where the image voxel is centred, in-plane (compose) and across it.
      const centre = at * s + (s - 1) / 2;
      if (at < 0) return null;
      const overlays = scene.overlays.map(async (overlay): Promise<OverlayPlane | null> => {
        // The coarsest overlay level no coarser than the image's (labels never blend).
        const o =
          [...overlay.levels].reverse().find((l) => l.scaleZyx[axis] <= s) ?? overlay.levels[0]!;
        const i = levelIndex(centre, overlay.offsetZyx[axis], o.scaleZyx[axis], o.shapeZyx[axis]);
        if (i < 0) return null;
        const plane = await readPlane(overlay.base, o.path, axis, i, abort.signal);
        return { overlay, plane, scale: o.scaleZyx[ra] };
      });
      const [plane, ...layers] = await Promise.all([
        readPlane(scene.image.base, lvl.path, axis, at, abort.signal),
        ...overlays,
      ]);
      const present = layers.filter((l): l is OverlayPlane => !!l);
      return {
        axis,
        index: at * s + (s - 1) / 2,
        rgba: compose(plane!, s, axis, contrast, present),
        rows: plane!.rows,
        cols: plane!.cols,
        scale: s,
      };
    };
    // Whether this effect drew a picture of the requested slice; if none, the old one goes.
    let current = false;
    const show = (picture: Picture | null, k: number) => {
      if (!picture || abort.signal.aborted) return;
      draw(picture);
      setShown({ level: k, index, contrast, overlays: scene.overlays });
      setError(undefined);
      current = true;
    };
    const coarsest = scene.image.levels.length - 1;
    (async () => {
      const fine = load(level);
      if (level !== coarsest) {
        // Only a fine picture that arrives skips the coarse one; a failed fine load doesn't.
        const arrived = fine.then(
          () => true,
          () => false,
        );
        const coarse = await load(coarsest).catch(() => null);
        const quick = await Promise.race([arrived, new Promise((go) => setTimeout(go, 80))]);
        if (!quick) show(coarse, coarsest);
      }
      show(await fine, level);
    })()
      .catch((cause) => {
        if (!abort.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (!current && !abort.signal.aborted) clear();
      });
    return () => abort.abort();
  }, [index, level, contrast, axis, scene.overlays]);

  function draw(picture: Picture) {
    const t = three.current;
    if (!t) return;
    t.image.geometry.dispose();
    t.image.geometry = quad(corners(picture).map((p) => [...toPane(p), 0]));
    t.image.material.map?.dispose();
    t.image.material.map = texture(picture, false);
    t.image.material.needsUpdate = true;
    t.image.visible = true;
    t.render();
  }

  // Never leave another slice's picture labelled as the requested one.
  function clear() {
    const t = three.current;
    if (t) {
      t.image.visible = false;
      t.render();
    }
    setShown(null);
  }

  // Crosshair: the other two planes' traces, each in its plane's colour.
  useEffect(() => {
    const t = three.current;
    if (!t) return;
    const [x, y] = toPane(point);
    const w = scene.shapeZyx[ca] * sc;
    const h = scene.shapeZyx[ra] * sr;
    const colorOf = (a: Axis) => {
      const c = axisColor(a);
      const n = Number.parseInt(c.slice(1), 16);
      return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
    };
    const rowColor = colorOf(ra);
    const colColor = colorOf(ca);
    t.cross.geometry.dispose();
    const g = new BufferGeometry();
    // A horizontal line holds the row axis constant; a vertical one, the column axis.
    g.setAttribute(
      "position",
      new Float32BufferAttribute([0, y, 1, w, y, 1, x, 0, 1, x, -h, 1], 3),
    );
    g.setAttribute(
      "color",
      new Float32BufferAttribute([...rowColor, ...rowColor, ...colColor, ...colColor], 3),
    );
    t.cross.geometry = g;
    t.render();
  }, [point]);

  // Pointer and wheel.
  useEffect(() => {
    const element = host.current!;
    const toVoxel = (event: { clientX: number; clientY: number }): Zyx => {
      const rect = element.getBoundingClientRect();
      const v = view.current!;
      const mmX = v.center[0] + (event.clientX - rect.left - rect.width / 2) / v.zoom;
      const mmY = v.center[1] - (event.clientY - rect.top - rect.height / 2) / v.zoom;
      const p = [...latest.current.point];
      p[ca] = clamp(Math.round(mmX / sc), scene.shapeZyx[ca]);
      p[ra] = clamp(Math.round(-mmY / sr), scene.shapeZyx[ra]);
      return p as unknown as Zyx;
    };
    // Where the pointer is on this slice, between voxel centres: a line's or an outline's points.
    const toPosition = (event: { clientX: number; clientY: number }): Zyx => {
      const rect = element.getBoundingClientRect();
      const v = view.current!;
      const mmX = v.center[0] + (event.clientX - rect.left - rect.width / 2) / v.zoom;
      const mmY = v.center[1] - (event.clientY - rect.top - rect.height / 2) / v.zoom;
      const p = [...latest.current.point];
      p[ca] = hundredths(Math.max(0, Math.min(scene.shapeZyx[ca] - 1, mmX / sc)));
      p[ra] = hundredths(Math.max(0, Math.min(scene.shapeZyx[ra] - 1, -mmY / sr)));
      return p as unknown as Zyx;
    };
    // The gesture's pointer is the mark layer's; the rest of it is the pane's.
    let drag: {
      mode: "cross" | "pan" | MarkTool;
      x: number;
      y: number;
      from: Zyx;
      moved: boolean;
      /** An outline's points, and the screen position of the last. */
      path: Zyx[];
      last: [number, number];
    } | null = null;
    const stopReset = layer.onCancel(() => {
      drag = null;
    });
    const down = (event: PointerEvent) => {
      if (drag || !view.current) return;
      element.focus({ preventScroll: true });
      layer.start(event);
      const pan = event.button === 1 || event.button === 2 || event.shiftKey;
      const from = toPosition(event);
      drag = {
        mode: pan ? "pan" : (latest.current.tool ?? "cross"),
        x: event.clientX,
        y: event.clientY,
        from,
        moved: false,
        path: [from],
        last: [event.clientX, event.clientY],
      };
      if (drag.mode === "cross") latest.current.onPoint(toVoxel(event));
    };
    const move = (event: PointerEvent) => {
      const tool = latest.current.tool;
      if (!drag) {
        if (tool === "point" || tool === "line") {
          layer.hover = toVoxel(event);
          layer.redraw();
        }
        return;
      }
      if (!layer.owns(event)) return;
      if (drag.mode === "cross") latest.current.onPoint(toVoxel(event));
      else if (drag.mode !== "pan") {
        if (!drag.moved && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < CLICK_PX)
          return;
        drag.moved = true;
        // On the slice the gesture began on, even if the wheel stepped since.
        const to = [...toPosition(event)] as [number, number, number];
        to[axis] = drag.from[axis];
        if (drag.mode === "box") layer.draft = boxMark(round(drag.from), round(to));
        else if (drag.mode === "line") {
          layer.hover = null;
          layer.draft = {
            line: {
              aZyx: [...drag.from],
              bZyx: [...to],
              lengthMm: lengthMm(drag.from, to, scene.spacingZyx),
            },
          };
        } else if (drag.mode === "outline") {
          if (
            Math.hypot(event.clientX - drag.last[0], event.clientY - drag.last[1]) < OUTLINE_STEP_PX
          )
            return;
          drag.last = [event.clientX, event.clientY];
          drag.path.push(to);
          layer.draft = {
            outline: {
              axis,
              zyx: drag.path.map((p) => [...p]),
              areaMm2: areaMm2(drag.path, axis, scene.spacingZyx),
            },
          };
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
        three.current?.render();
      }
    };
    const up = (event: PointerEvent) => {
      if (!drag || !layer.owns(event)) return;
      move(event);
      const made = finish(drag);
      layer.cancel();
      if (!made) return;
      latest.current.onMark(made);
      // A point moves the crosshair to it, so every pane shows it.
      if ("point" in made) latest.current.onPoint(made.point);
    };
    // The mark a finished gesture makes, if any: a click marks only with Point.
    const finish = (d: NonNullable<typeof drag>): GridMark | null => {
      if (d.mode === "cross" || d.mode === "pan") return null;
      if (d.mode === "point") return d.moved ? null : { point: [...round(d.from)] };
      const made = layer.draft;
      if (made && "line" in made && made.line.lengthMm > 0) return made;
      if (made && "box" in made) return made;
      if (made && "outline" in made) {
        const zyx = thin(made.outline.zyx, OUTLINE_MAX);
        const area = areaMm2(zyx, axis, scene.spacingZyx);
        if (zyx.length >= 3 && area > 0) return { outline: { axis, zyx, areaMm2: area } };
      }
      return null;
    };
    const leave = () => {
      if (!layer.hover) return;
      layer.hover = null;
      layer.redraw();
    };
    // A box dragged on one slice spans that slice's two axes; across the held axis it takes the
    // smaller of the two dragged sides in mm, centred on the slice, so it reads as a region.
    const boxMark = (a: Zyx, b: Zyx): GridMark => {
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
        box: { min: min as [number, number, number], max: max as [number, number, number] },
      };
    };
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      if (event.ctrlKey || event.metaKey) {
        const v = view.current!;
        const rect = element.getBoundingClientRect();
        const dx = event.clientX - rect.left - rect.width / 2;
        const dy = event.clientY - rect.top - rect.height / 2;
        const before = [v.center[0] + dx / v.zoom, v.center[1] - dy / v.zoom];
        v.zoom = Math.min(
          v.fit * 64,
          Math.max(v.fit / 2, v.zoom * Math.exp(-event.deltaY * 0.002)),
        );
        v.center = [before[0]! - dx / v.zoom, before[1]! + dy / v.zoom];
        three.current?.render();
        pickLevel();
        return;
      }
      step(Math.sign(event.deltaY));
    };
    const step = (by: number) => {
      const p = [...latest.current.point];
      p[axis] = clamp(p[axis]! + by, scene.shapeZyx[axis]);
      latest.current.onPoint(p as unknown as Zyx);
    };
    const key = (event: KeyboardEvent) => {
      if (event.target !== element) return;
      const by = { ArrowUp: -1, ArrowDown: 1, PageUp: -10, PageDown: 10 }[event.key];
      if (by === undefined) return;
      event.preventDefault();
      step(by);
    };
    const menu = (event: Event) => event.preventDefault();
    element.addEventListener("pointerdown", down);
    element.addEventListener("pointermove", move);
    element.addEventListener("pointerup", up);
    element.addEventListener("pointerleave", leave);
    element.addEventListener("wheel", wheel, { passive: false });
    element.addEventListener("keydown", key);
    element.addEventListener("contextmenu", menu);
    return () => {
      stopReset();
      element.removeEventListener("pointerdown", down);
      element.removeEventListener("pointermove", move);
      element.removeEventListener("pointerup", up);
      element.removeEventListener("pointerleave", leave);
      element.removeEventListener("wheel", wheel);
      element.removeEventListener("keydown", key);
      element.removeEventListener("contextmenu", menu);
    };
  }, []);

  const total = scene.shapeZyx[axis];
  // Another slice or level on its way: the picture shown is a stand-in.
  const refining = shown && (shown.level !== level || shown.index !== index);
  // A display change (contrast, overlays) also leaves the picture out of date for a moment.
  const stale =
    refining || (shown && (shown.contrast !== contrast || shown.overlays !== scene.overlays));
  const status: PaneStatus =
    (!shown && !error) || (traces.size !== traceMeshes.length && !traceError)
      ? "loading"
      : stale && !error
        ? "refining"
        : error || traceError
          ? "failed"
          : "ready";
  useEffect(() => latest.current.onStatus(status), [status]);
  const scale = shown ? scene.image.levels[shown.level]!.scaleZyx[axis] : null;
  return (
    <div
      ref={host}
      className={PANE}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: the pane takes arrow keys to step slices.
      tabIndex={0}
      role="img"
      aria-label={`Slice ${index + 1} of ${total}`}
    >
      <span className={cx(CHIP, "bottom-2 left-2")}>
        {index + 1} / {total}
        {scale && scale > 1 && <span className="ml-2">1:{scale}</span>}
      </span>
      {(!shown || refining) && !error && (
        <span className={cx(CHIP, "top-2 right-2")} role="status">
          {shown ? "Loading full resolution…" : "Loading…"}
        </span>
      )}
      {error && (
        <span className={cx(CHIP, "top-2 right-2")} role="alert">
          Couldn't load this slice: {error}
        </span>
      )}
      {traceError && (
        <span className={cx(CHIP, "top-2 right-2")} role="alert">
          {traceError}
        </span>
      )}
    </div>
  );
}

const clamp = (n: number, size: number) => Math.max(0, Math.min(size - 1, n));
const round = (p: Zyx) => p.map(Math.round) as unknown as Zyx;
/** A position to 0.01 voxel: finer says nothing and only lengthens the message. */
const hundredths = (n: number) => Math.round(n * 100) / 100;
