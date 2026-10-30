/**
 * One slice pane of the grid viewer: the plane through the crosshair that holds `axis`
 * constant, drawn by three.js with an orthographic camera in mm. It opens on the coarsest
 * level and refines to the level the zoom needs. Left drag moves the crosshair, the wheel
 * steps slices, Ctrl or ⌘ + wheel zooms at the pointer, Shift, middle or right drag pans.
 */
import { useEffect, useRef, useState } from "react";
import {
  BufferGeometry,
  Float32BufferAttribute,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  OrthographicCamera,
  Scene,
  WebGLRenderer,
} from "three";
import { type Contrast, compose, type OverlayPlane } from "./compose";
import { corners, type Picture, quad, texture } from "./picture";
import { readPlane } from "./planes";
import {
  type Axis,
  capturePane,
  type GridScene,
  levelFor,
  levelIndex,
  type PaneHandle,
  type PaneView,
  planeAxes,
  type Zyx,
} from "./scene";

export const axisColor = (axis: Axis) =>
  getComputedStyle(document.documentElement).getPropertyValue(
    axis === 0 ? "--axis-z" : axis === 1 ? "--axis-y" : "--axis-x",
  );

/** Pixels per mm, the zoom that fits the grid in the pane, and the pane centre in mm. */
type View = { zoom: number; fit: number; center: [number, number] };

export function SlicePane({
  axis,
  scene,
  point,
  onPoint,
  contrast,
  handle,
}: {
  axis: Axis;
  scene: GridScene;
  point: Zyx;
  onPoint(point: Zyx): void;
  contrast: Contrast | null;
  /** Set while the pane is mounted, for screenshots. */
  handle: { current: PaneHandle | null };
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
    render(): void;
  } | null>(null);
  const view = useRef<View | null>(null);
  // A saved view shown before the pane had a size: applied when it gets one.
  const pending = useRef<{ zoom: number; center: [number, number] } | null>(null);
  const [level, setLevel] = useState(scene.image.levels.length - 1);
  const [shown, setShown] = useState<{ level: number; index: number } | null>(null);
  const [error, setError] = useState<string>();
  const latest = useRef({ point, onPoint });
  latest.current = { point, onPoint };

  // Pane mm: columns run right, rows run down.
  const toPane = (p: Zyx): [number, number] => [p[ca] * sc, -p[ra] * sr];

  // The renderer lives as long as the pane; resizing only changes its size.
  useEffect(() => {
    const element = host.current!;
    const renderer = new WebGLRenderer({ antialias: false });
    renderer.setPixelRatio(globalThis.devicePixelRatio);
    renderer.setClearColor(
      getComputedStyle(document.documentElement).getPropertyValue("--viewer-well").trim(),
    );
    element.append(renderer.domElement);
    renderer.domElement.className = "grid-canvas";
    const camera = new OrthographicCamera(-1, 1, 1, -1, -10, 10);
    const s = new Scene();
    const image = new Mesh(new BufferGeometry(), new MeshBasicMaterial());
    const cross = new LineSegments(
      new BufferGeometry(),
      new LineBasicMaterial({ vertexColors: true, depthTest: false }),
    );
    cross.renderOrder = 1;
    s.add(image, cross);
    const state = {
      renderer,
      camera,
      scene: s,
      image,
      cross,
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
      setShown({ level: k, index });
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
      const c = axisColor(a).trim();
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
    let drag: { mode: "point" | "pan"; x: number; y: number } | null = null;
    const down = (event: PointerEvent) => {
      element.setPointerCapture(event.pointerId);
      const pan = event.button === 1 || event.button === 2 || event.shiftKey;
      drag = { mode: pan ? "pan" : "point", x: event.clientX, y: event.clientY };
      if (!pan) latest.current.onPoint(toVoxel(event));
    };
    const move = (event: PointerEvent) => {
      if (!drag) return;
      if (drag.mode === "point") latest.current.onPoint(toVoxel(event));
      else {
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
    const up = () => {
      drag = null;
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
      const by = { ArrowUp: -1, ArrowDown: 1, PageUp: -10, PageDown: 10 }[event.key];
      if (by === undefined) return;
      event.preventDefault();
      step(by);
    };
    const menu = (event: Event) => event.preventDefault();
    element.addEventListener("pointerdown", down);
    element.addEventListener("pointermove", move);
    element.addEventListener("pointerup", up);
    element.addEventListener("pointercancel", up);
    element.addEventListener("wheel", wheel, { passive: false });
    element.addEventListener("keydown", key);
    element.addEventListener("contextmenu", menu);
    return () => {
      element.removeEventListener("pointerdown", down);
      element.removeEventListener("pointermove", move);
      element.removeEventListener("pointerup", up);
      element.removeEventListener("pointercancel", up);
      element.removeEventListener("wheel", wheel);
      element.removeEventListener("keydown", key);
      element.removeEventListener("contextmenu", menu);
    };
  }, []);

  const total = scene.shapeZyx[axis];
  const refining = shown && (shown.level !== level || shown.index !== index);
  const scale = shown ? scene.image.levels[shown.level]!.scaleZyx[axis] : null;
  return (
    <div
      ref={host}
      className="grid-pane"
      // biome-ignore lint/a11y/noNoninteractiveTabindex: the pane takes arrow keys to step slices.
      tabIndex={0}
      role="img"
      aria-label={`Slice ${index + 1} of ${total}`}
    >
      <span className="grid-chip bottom-left">
        {index + 1} / {total}
        {scale && scale > 1 ? ` · 1:${scale}` : ""}
      </span>
      {(!shown || refining) && !error && (
        <span className="grid-chip top-right" role="status">
          {shown ? "Loading full resolution…" : "Loading…"}
        </span>
      )}
      {error && (
        <span className="grid-chip top-right" role="alert">
          Couldn't load this slice: {error}
        </span>
      )}
    </div>
  );
}

const clamp = (n: number, size: number) => Math.max(0, Math.min(size - 1, n));
