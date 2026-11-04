/**
 * One slice pane of the grid viewer: the plane through the crosshair with normal `basis.normal`,
 * drawn by three.js with an orthographic camera in pane mm (`basis.right` across, `basis.down`
 * down). Untilted (the grid's own axes, the default), it reads whole slices of the grid, opening
 * on the coarsest level and refining to the level the zoom needs. Tilted, it does the same, each
 * picture resliced from the chunks the plane crosses (`reslice.ts`). The gestures (moving
 * the crosshair, stepping, zooming, panning, marking) are `slice-gestures.ts`; `marks.ts` draws
 * the marks. With `onTilt`, the dots near both ends of the other planes' crosshair lines turn
 * those planes about this pane's normal; this pane stays still. With `onSpin`, Alt-drag and `,` `.`
 * turn this pane's image in place about the crosshair. Esc drops a mark being drawn.
 */
import { Button, cx } from "@voluma/ui";
import { useEffect, useId, useMemo, useRef, useState } from "react";
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
import { type Contrast, compose, composeSampled, type OverlayPlane } from "./compose";
import {
  type Basis,
  cross,
  dot,
  gridBasis,
  nearestAxis,
  onGrid,
  slabOf,
  unit,
  type Vec3,
} from "./frame";
import { loadMesh, sliceSegment, surfaceTrace } from "./geometry";
import { sliceShape, useMarkLayer } from "./marks";
import { CHIP, PANE } from "./pane-style";
import { corners, quad, texture } from "./picture";
import { readPlane, readSlice } from "./planes";
import { onLevel, sampling, samplingCorners, type Window, windowAround } from "./reslice";
import {
  type Axis,
  type GridMark,
  type GridScene,
  levelFor,
  levelIndex,
  type MarkEdit,
  type MarkTool,
  type PaneHandle,
  type PaneStatus,
  type PaneView,
  planeAxes,
  type ShownMark,
  type VoxelBox,
  type Zyx,
} from "./scene";
import { type PaneCamera, type Probe, useSliceGestures } from "./slice-gestures";
import { tokenColor } from "./token-color";

/**
 * The colour token of the plane holding array axis `axis` constant, when the caller gives none:
 * z axial, y sagittal, x coronal.
 */
export const axisToken = (axis: Axis) =>
  axis === 0 ? "--plane-axial" : axis === 1 ? "--plane-sagittal" : "--plane-coronal";

/** The least a framed region spans, in source voxels of the finest spacing, so a point frames a neighbourhood. */
const FRAME_MIN_VOXELS = 48;

/** How far out the tilt handles sit, of the pane's half size. */
const HANDLE_REACH = 0.85;

/** Another plane through the crosshair, drawn as a line across this pane in its colour. */
export type Cut = { axis: Axis; normal: Vec3; token?: string };

export function SlicePane({
  axis,
  basis: given,
  cuts: givenCuts,
  scene,
  point,
  onPoint,
  contrast,
  handle,
  onStatus,
  tool,
  marks,
  onMark,
  onTilt,
  onSpin,
  onEdit,
  onPick,
  planeToken = axisToken,
}: {
  /** The grid axis the pane holds when untilted; a tilted pane names the axis it started on. */
  axis: Axis;
  /** Where the pane lies; the grid's own axes when absent. */
  basis?: Basis;
  /** The other planes, drawn as the crosshair's lines; the grid's other two axes when absent. */
  cuts?: readonly Cut[];
  scene: GridScene;
  /** The crosshair in source voxels; an untilted pane shows its nearest whole slice. */
  point: Zyx;
  onPoint(point: Zyx): void;
  contrast: Contrast | null;
  /** What a left click or drag makes; none moves the crosshair. */
  tool: MarkTool | null;
  marks: readonly ShownMark[];
  onMark(mark: GridMark): void;
  /** An end of a movable mark or a published ruler dragged; absent, none can be. */
  onEdit?(edit: MarkEdit): void;
  /** A mark selected in the pane, or undefined to clear the selection. */
  onPick?(id?: string): void;
  /** Turns the cut planes by `angle` radians about this pane's normal; absent, no handles. */
  onTilt?(angle: number): void;
  /** Turns this pane's image by `angle` radians clockwise on screen; absent, it can't be turned. */
  onSpin?(angle: number): void;
  /** Set while the pane is mounted, for screenshots. */
  handle: { current: PaneHandle | null };
  onStatus(status: PaneStatus): void;
  /** Each plane's colour token, for the crosshair lines; stable, or the lines redraw each render. */
  planeToken?: (axis: Axis) => string | undefined;
}) {
  const [ra, ca] = planeAxes(axis);
  const basis = useStable(given ?? gridBasis(axis));
  const whole = onGrid(basis, axis);
  const cuts = useStable(
    givenCuts ??
      [ra, ca].map((a) => ({ axis: a, normal: gridBasis(a).normal, token: planeToken(a) })),
  );
  const s = scene.spacingZyx;
  const host = useRef<HTMLDivElement>(null);
  const three = useRef<{
    renderer: WebGLRenderer;
    camera: OrthographicCamera;
    scene: Scene;
    image: Mesh<BufferGeometry, MeshBasicMaterial>;
    /** A tilted pane's coarse picture of the whole outline, under the windowed fine one. */
    under: Mesh<BufferGeometry, MeshBasicMaterial>;
    cross: LineSegments<BufferGeometry, LineBasicMaterial>;
    drawings: Group;
    render(): void;
  } | null>(null);
  const view = useRef<PaneCamera | null>(null);
  // A saved view shown before the pane had a size: applied when it gets one.
  const pending = useRef<{ zoom: number; center: [number, number] } | null>(null);
  // A region framed before the pane had a size: framed when it gets one.
  const pendingBox = useRef<VoxelBox | null>(null);
  const [level, setLevel] = useState(scene.image.levels.length - 1);
  // A tilted pane's fine picture covers this window of pane mm; panning near its edge bumps
  // `reframe`, which loads a new one.
  const fineWindow = useRef<Window | null>(null);
  const [reframe, setReframe] = useState(0);
  // The plane each layer shows: the fine picture (`image`), and a tilted pane's coarse one (`under`).
  const drawnKey = useRef<Record<"image" | "under", string | null>>({ image: null, under: null });
  const [shown, setShown] = useState<{
    key: string;
    level: number;
    contrast: Contrast;
    overlays: GridScene["overlays"];
  } | null>(null);
  const [error, setError] = useState<string>();
  const [traceError, setTraceError] = useState<string>();
  const [traces, setTraces] = useState<Map<string, BufferGeometry>>(new Map());
  const probe = useRef<Probe | null>(null);

  // Pane mm: columns run along `right`, rows along `down`.
  const toPane = (p: Zyx): [number, number] => {
    const mm: Vec3 = [p[0] * s[0], p[1] * s[1], p[2] * s[2]];
    return [dot(mm, basis.right), -dot(mm, basis.down)];
  };
  // The source position on this pane's plane at pane mm (x, y).
  const fromPane = (x: number, y: number, at: Zyx): Zyx => {
    const n = basis.normal;
    const depth = at[0] * s[0] * n[0] + at[1] * s[1] * n[1] + at[2] * s[2] * n[2];
    return [0, 1, 2].map(
      (k) => (x * basis.right[k]! - y * basis.down[k]! + depth * n[k]!) / s[k]!,
    ) as unknown as Zyx;
  };
  const slab = slabOf(basis, axis, point, s);
  const index = Math.round(point[axis]);
  // What changes the picture: an untilted pane's slice, a tilted pane's plane.
  const planeKey = whole
    ? `${index}`
    : `${basis.normal.join()}|${basis.right.join()}|${dot(point.map((v, k) => v * s[k]!) as unknown as Vec3, basis.normal)}`;

  const latest = useRef({
    point,
    onPoint,
    onStatus,
    tool,
    marks,
    onMark,
    onTilt,
    onSpin,
    toPane,
    fromPane,
    basis,
    cuts,
    whole,
    slab,
    annotations: scene.annotations,
    onEdit,
    onPick,
  });
  latest.current = {
    point,
    onPoint,
    onStatus,
    tool,
    marks,
    onMark,
    onTilt,
    onSpin,
    toPane,
    fromPane,
    basis,
    cuts,
    whole,
    slab,
    annotations: scene.annotations,
    onEdit,
    onPick,
  };

  /** Where each cut crosses the crosshair, as a unit direction in pane mm (right, up). */
  const cutDirections = () => {
    const { basis: b, cuts: cs } = latest.current;
    return cs.flatMap((c) => {
      const d = cross(b.normal, c.normal);
      if (Math.hypot(...d) < 1e-6) return [];
      const u = unit(d);
      const along: [number, number] = [dot(u, b.right), -dot(u, b.down)];
      return [{ cut: c, along: along.map((v) => v / Math.hypot(...along)) as [number, number] }];
    });
  };
  /** The tilt handles in CSS px: two per cut, near the ends of its line. */
  const handlesNow = (width: number, height: number) => {
    const v = view.current;
    if (!v || !latest.current.onTilt) return [];
    const [cxMm, cyMm] = latest.current.toPane(latest.current.point);
    const centre = [
      (cxMm - v.center[0]) * v.zoom + width / 2,
      (v.center[1] - cyMm) * v.zoom + height / 2,
    ];
    const reach = (HANDLE_REACH * Math.min(width, height)) / 2;
    return cutDirections().flatMap(({ cut, along }) =>
      [1, -1].map((sign) => ({
        cut,
        sign,
        x: centre[0]! + sign * along[0] * reach,
        y: centre[1]! - sign * along[1] * reach,
        color: tokenColor(cut.token ?? "--viewer-chip-fg"),
      })),
    );
  };

  const showHandles = useRef(false);
  const layer = useMarkLayer(
    host,
    () => {
      const v = view.current;
      const canvas = host.current;
      if (!v || !canvas) return null;
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      const { slab: sl, whole: w, point: p, toPane: tp } = latest.current;
      return {
        project: (q) => {
          const [x, y] = tp(q);
          return [(x - v.center[0]) * v.zoom + width / 2, (v.center[1] - y) * v.zoom + height / 2];
        },
        shapeOf: (mark) => sliceShape(mark, sl, w ? { axis, at: Math.round(p[axis]) } : null),
        handles: showHandles.current ? handlesNow(width, height) : [],
      };
    },
    tool,
    marks,
    onPick,
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
    const sc = new Scene();
    // Transparent, so a resliced picture's corners off the grid show the well.
    const image = new Mesh(new BufferGeometry(), new MeshBasicMaterial({ transparent: true }));
    const under = new Mesh(new BufferGeometry(), new MeshBasicMaterial({ transparent: true }));
    under.position.z = -1;
    under.renderOrder = -1;
    const cross = new LineSegments(
      new BufferGeometry(),
      new LineBasicMaterial({ vertexColors: true, transparent: true, depthTest: false }),
    );
    cross.renderOrder = 1;
    const drawings = new Group();
    sc.add(under, image, cross, drawings);
    const state = {
      renderer,
      camera,
      scene: sc,
      image,
      under,
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
      // Ruler-end dots are 5 px radius at any zoom (their geometry is in pixels).
      for (const o of drawings.children) if (o.userData.dot) o.scale.setScalar(1 / v.zoom);
      renderer.render(sc, camera);
      layer.draw();
      // A tilted pane panned or zoomed out near its fine picture's edge loads a new window.
      const w = fineWindow.current;
      if (
        w &&
        (camera.left - (camera.right - camera.left) / 8 < w.xMin ||
          camera.right + (camera.right - camera.left) / 8 > w.xMax ||
          camera.bottom - (camera.top - camera.bottom) / 8 < w.yMin ||
          camera.top + (camera.top - camera.bottom) / 8 > w.yMax)
      ) {
        fineWindow.current = null;
        setReframe((n) => n + 1);
      }
    };
    const [rows, cols] = [scene.shapeZyx[ra] * s[ra], scene.shapeZyx[ca] * s[ca]];
    const fitZoom = (width: number, height: number) => Math.min(width / cols, height / rows) * 0.95;
    three.current = state;
    // A pane never shown has no size, so no view yet: a saved view still waiting to apply, or none.
    const now = (): PaneView | null => {
      const v = view.current;
      if (!v) return pending.current;
      return { zoom: v.zoom / v.fit, center: [v.center[0], v.center[1]] };
    };
    // Centres on the box and zooms until its outline on this plane fills about four fifths of
    // the pane: at least FRAME_MIN_VOXELS of the finest spacing across, never out past the fit.
    const frameBox = (box: VoxelBox) => {
      const v = view.current;
      const { width, height } = element.getBoundingClientRect();
      if (!v || !width || !height) {
        pendingBox.current = box;
        return;
      }
      pendingBox.current = null;
      const xs: number[] = [];
      const ys: number[] = [];
      for (const z of [box.min[0] - 0.5, box.max[0] + 0.5])
        for (const y of [box.min[1] - 0.5, box.max[1] + 0.5])
          for (const x of [box.min[2] - 0.5, box.max[2] + 0.5]) {
            const [px, py] = latest.current.toPane([z, y, x]);
            xs.push(px);
            ys.push(py);
          }
      const least = FRAME_MIN_VOXELS * Math.min(...s);
      const across = Math.max(Math.max(...xs) - Math.min(...xs), least);
      const down = Math.max(Math.max(...ys) - Math.min(...ys), least);
      v.zoom = Math.max(v.fit, Math.min(width / across, height / down) * 0.8);
      v.center = [(Math.max(...xs) + Math.min(...xs)) / 2, (Math.max(...ys) + Math.min(...ys)) / 2];
      state.render();
      pickLevel();
    };
    handle.current = {
      view: now,
      layers: () => layer.layers(renderer.domElement, paint),
      show(saved: PaneView) {
        if (!("zoom" in saved)) return;
        pendingBox.current = null;
        if (!view.current) {
          pending.current = saved;
          return;
        }
        view.current.zoom = saved.zoom * view.current.fit;
        view.current.center = [saved.center[0], saved.center[1]];
        state.render();
        pickLevel();
      },
      frame: frameBox,
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
        center:
          pending.current?.center ??
          latest.current.toPane(scene.shapeZyx.map((n) => (n - 1) / 2) as unknown as Zyx),
      };
      view.current.fit = fitted;
      if (pendingBox.current) frameBox(pendingBox.current);
      else {
        state.render();
        pickLevel();
      }
    });
    observer.observe(element);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      for (const m of [image, under]) {
        m.geometry.dispose();
        m.material.map?.dispose();
        m.material.dispose();
      }
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

  // A turned plane keeps the crosshair where it was on screen: the picture turns about it.
  const turned = useRef(basis);
  useEffect(() => {
    const was = turned.current;
    turned.current = basis;
    const v = view.current;
    if (!v || was === basis) return;
    const mm: Vec3 = [point[0] * s[0], point[1] * s[1], point[2] * s[2]];
    v.center = [
      v.center[0] + dot(mm, basis.right) - dot(mm, was.right),
      v.center[1] - dot(mm, basis.down) + dot(mm, was.down),
    ];
    three.current?.render();
  }, [basis]);

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
          return [m.id, geometry ? surfaceTrace(geometry, slab, m.offsetZyx) : []];
        }),
      ),
    [traces, traceLayout, planeKey],
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
        new LineBasicMaterial({ color, opacity, transparent: true, depthTest: false }),
      );
      object.renderOrder = 2;
      objects.push(object);
    };
    for (const m of traceMeshes) line(traceSegments.get(m.id) ?? [], m.color, m.opacity);
    for (const a of scene.annotations) {
      if (a.opacity <= 0) continue;
      let dots = [...a.points];
      if (a.points.length === 2) {
        const segment = sliceSegment(a.points[0]!, a.points[1]!, slab);
        if (segment) {
          line(segment, a.color, a.opacity);
          // A ruler crossing perpendicular to the pane projects to a point, not a visible line.
          const [p, q] = segment.map(toPane) as [[number, number], [number, number]];
          if (Math.hypot(p[0] - q[0], p[1] - q[1]) < Math.min(s[ra], s[ca])) dots = [segment[0]];
        }
      }
      for (const p of dots) {
        if (Math.abs(slab(p)) > 0.5) continue;
        const dotMesh = new Mesh(
          new CircleGeometry(5, 12),
          new MeshBasicMaterial({
            color: a.color,
            opacity: a.opacity,
            transparent: true,
            depthTest: false,
          }),
        );
        dotMesh.position.set(...toPane(p), 2);
        dotMesh.renderOrder = 2;
        dotMesh.userData.dot = true;
        objects.push(dotMesh);
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
  }, [planeKey, scene.annotations, scene.meshes, traceSegments]);

  /** The level that gives each device pixel at least one voxel at the current zoom. */
  function pickLevel() {
    const v = view.current;
    if (!v) return;
    const mmPerPixel = 1 / (v.zoom * globalThis.devicePixelRatio);
    setLevel(levelFor(scene.image.levels, mmPerPixel / Math.min(s[ra], s[ca])));
  }

  // Load the plane through the crosshair at the level the zoom needs: untilted, a whole slice of
  // the level; tilted, the plane resliced from the level's chunks it crosses, over the coarsest
  // level's picture of the whole outline. Untilted, the coarsest level shows meanwhile, unless the
  // finer one arrives almost as soon (it does from the worker's cache).
  useEffect(() => {
    if (!contrast) return;
    const abort = new AbortController();
    const slice = async (k: number) => {
      const lvl = scene.image.levels[k]!;
      const sc = lvl.scaleZyx[axis];
      const at = levelIndex(index, 0, sc, lvl.shapeZyx[axis]);
      // Overlays are sampled where the image voxel is centred, in-plane (compose) and across it.
      const centre = at * sc + (sc - 1) / 2;
      if (at < 0) return null;
      const overlays = scene.overlays.map(async (overlay): Promise<OverlayPlane | null> => {
        // The coarsest overlay level no coarser than the image's (labels never blend).
        const o =
          [...overlay.levels].reverse().find((l) => l.scaleZyx[axis] <= sc) ?? overlay.levels[0]!;
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
      const picture = {
        axis,
        index: at * sc + (sc - 1) / 2,
        rgba: compose(plane!, sc, axis, contrast, present),
        rows: plane!.rows,
        cols: plane!.cols,
        scale: sc,
      };
      // The probe reads the level voxel under the pointer, on this slice only.
      const read: Probe = (p) => {
        if (Math.round(p[axis]) !== index) return null;
        const r = Math.floor((p[ra] + 0.5) / sc);
        const c = Math.floor((p[ca] + 0.5) / sc);
        if (r < 0 || c < 0 || r >= plane!.rows || c >= plane!.cols) return null;
        const inside = present
          .filter((l) => {
            const ro = Math.floor((p[ra] - l.overlay.offsetZyx[ra] + 0.5) / l.scale);
            const co = Math.floor((p[ca] - l.overlay.offsetZyx[ca] + 0.5) / l.scale);
            return (
              ro >= 0 &&
              co >= 0 &&
              ro < l.plane.rows &&
              co < l.plane.cols &&
              !!l.plane.data[ro * l.plane.cols + co]
            );
          })
          .map((l) => l.overlay.name);
        return {
          value: plane!.data[r * plane!.cols + c]!,
          unit: scene.imageUnit ?? null,
          approx: sc > 1,
          inside,
        };
      };
      return { ...picture, corners: corners(picture).map(toPane), read };
    };
    // A level's finest voxel side in mm: a tilted picture's sample step on it.
    const stepOf = (k: number) =>
      Math.min(...scene.image.levels[k]!.scaleZyx.map((v, i) => v * s[i]!));
    const tilted = async (k: number, window?: Window) => {
      const lvl = scene.image.levels[k]!;
      const sc = Math.max(...lvl.scaleZyx);
      const at = sampling(basis, point, s, scene.shapeZyx, stepOf(k), window);
      const overlays = scene.overlays.map(async (overlay) => {
        // The coarsest overlay level no coarser than the image's (labels never blend).
        const o =
          [...overlay.levels].reverse().find((l) => Math.max(...l.scaleZyx) <= sc) ??
          overlay.levels[0]!;
        const on = onLevel(at, basis, s, o.scaleZyx, overlay.offsetZyx);
        return {
          overlay,
          values: (await readSlice(overlay.base, o.path, on, true, abort.signal)).data,
        };
      });
      const [image, ...layers] = await Promise.all([
        readSlice(
          scene.image.base,
          lvl.path,
          onLevel(at, basis, s, lvl.scaleZyx, [0, 0, 0]),
          false,
          abort.signal,
        ),
        ...overlays,
      ]);
      const values = image.data as Float32Array;
      // The probe reads the sample nearest the pointer: trilinear on the level, so approximate.
      const read: Probe = (p) => {
        const [x, y] = toPane(p);
        const c = Math.round((x - at.x0) / at.step);
        const r = Math.round((at.y0 - y) / at.step);
        if (r < 0 || c < 0 || r >= at.rows || c >= at.cols) return null;
        const i = r * at.cols + c;
        if (Number.isNaN(values[i]!)) return null;
        const inside = layers.filter((l) => l.values[i]).map((l) => l.overlay.name);
        return { value: values[i]!, unit: scene.imageUnit ?? null, approx: true, inside };
      };
      return {
        rgba: composeSampled(values, at.cols, contrast, layers),
        rows: at.rows,
        cols: at.cols,
        corners: samplingCorners(at),
        read,
      };
    };
    // Whether this effect drew a picture of the requested plane; if none, the old one goes.
    let current = false;
    const shown = (k: number) => {
      setShown({ key: planeKey, level: k, contrast, overlays: scene.overlays });
      setError(undefined);
      current = true;
    };
    const coarsest = scene.image.levels.length - 1;
    const untilted = async () => {
      fineWindow.current = null;
      const show = (made: Awaited<ReturnType<typeof slice>>, k: number) => {
        if (!made || abort.signal.aborted) return;
        draw("under", null);
        draw("image", made, false);
        probe.current = made.read;
        shown(k);
      };
      const fine = slice(level);
      if (level !== coarsest) {
        // Only a fine picture that arrives skips the coarse one; a failed fine load doesn't.
        const arrived = fine.then(
          () => true,
          () => false,
        );
        const coarse = await slice(coarsest).catch(() => null);
        const quick = await Promise.race([arrived, new Promise((go) => setTimeout(go, 80))]);
        if (!quick) show(coarse, coarsest);
      }
      show(await fine, level);
    };
    const tiltedPair = async () => {
      const v = view.current;
      const el = host.current;
      const window =
        v && el?.clientWidth
          ? windowAround(
              {
                xMin: v.center[0] - el.clientWidth / 2 / v.zoom,
                xMax: v.center[0] + el.clientWidth / 2 / v.zoom,
                yMin: v.center[1] - el.clientHeight / 2 / v.zoom,
                yMax: v.center[1] + el.clientHeight / 2 / v.zoom,
              },
              stepOf(level),
            )
          : undefined;
      fineWindow.current = window ?? null;
      const fine = tilted(level, window);
      let coarseRead: Probe | null = null;
      let fineRead: Probe | null = null;
      const read: Probe = (p) => fineRead?.(p) ?? coarseRead?.(p) ?? null;
      // Settled here, so an abort never goes unhandled; its failure is the pane's only if the
      // fine picture fails too.
      const coarse = tilted(coarsest).then(
        (made) => {
          if (abort.signal.aborted) return;
          draw("under", made, true);
          coarseRead = made.read;
          // Another plane's fine picture would cover this one's coarse picture.
          if (drawnKey.current.image !== planeKey) {
            draw("image", null);
            probe.current = read;
            shown(coarsest);
          }
        },
        () => {},
      );
      const made = await fine.catch(async (cause) => {
        // The coarse picture shows first, so its arrival can't clear this error.
        await coarse;
        throw cause;
      });
      if (abort.signal.aborted) return;
      // Another plane's coarse picture would show around this one.
      if (drawnKey.current.under !== planeKey) draw("under", null);
      draw("image", made, true);
      fineRead = made.read;
      probe.current = read;
      shown(level);
    };
    (whole ? untilted() : tiltedPair())
      .catch((cause) => {
        if (!abort.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (!current && !abort.signal.aborted) clear();
      });
    return () => abort.abort();
  }, [planeKey, level, contrast, axis, scene.overlays, whole, reframe]);

  /** Shows a picture in one of the pane's two layers, or hides that layer. */
  function draw(
    layer: "image" | "under",
    picture: { rgba: Uint8Array; cols: number; rows: number; corners: [number, number][] } | null,
    smooth = false,
  ) {
    const t = three.current;
    if (!t) return;
    const mesh = t[layer];
    drawnKey.current[layer] = picture && planeKey;
    mesh.visible = !!picture;
    if (picture) {
      mesh.geometry.dispose();
      mesh.geometry = quad(picture.corners.map(([x, y]) => [x, y, 0]));
      mesh.material.map?.dispose();
      mesh.material.map = texture(picture, smooth);
      mesh.material.needsUpdate = true;
    }
    t.render();
  }

  // Never leave another slice's picture labelled as the requested one.
  function clear() {
    const t = three.current;
    if (t) {
      t.image.visible = false;
      t.under.visible = false;
      drawnKey.current = { image: null, under: null };
      t.render();
    }
    probe.current = null;
    setShown(null);
  }

  // Crosshair: the other planes' lines through it, each in its plane's colour.
  useEffect(() => {
    const t = three.current;
    if (!t) return;
    const [x, y] = toPane(point);
    const reach = Math.hypot(...scene.shapeZyx.map((n, k) => n * s[k]!));
    const colorOf = (token: string | undefined) => {
      const c = tokenColor(token ?? "--viewer-chip-fg");
      const n = Number.parseInt(c.slice(1), 16);
      return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
    };
    const positions: number[] = [];
    const colors: number[] = [];
    for (const { cut, along } of cutDirections()) {
      positions.push(
        x - along[0] * reach,
        y - along[1] * reach,
        1,
        x + along[0] * reach,
        y + along[1] * reach,
        1,
      );
      const c = colorOf(cut.token);
      colors.push(...c, ...c);
    }
    t.cross.geometry.dispose();
    const g = new BufferGeometry();
    g.setAttribute("position", new Float32BufferAttribute(positions, 3));
    g.setAttribute("color", new Float32BufferAttribute(colors, 3));
    t.cross.geometry = g;
    t.render();
  }, [point, basis, cuts]);

  const { readout, hovering, step } = useSliceGestures({
    host,
    view,
    render: () => three.current?.render(),
    layer,
    latest,
    probe,
    scene,
    axis,
    handlesNow,
    pickLevel,
  });
  showHandles.current = hovering && !tool && !!onTilt;
  useEffect(() => layer.redraw(), [hovering, tool, layer]);

  const total = scene.shapeZyx[axis];
  // Another slice or level on its way: the picture shown is a stand-in.
  const refining = shown && (shown.key !== planeKey || shown.level !== level);
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
  const scale = shown && Math.max(...scene.image.levels[shown.level]!.scaleZyx);
  // A tilted pane counts along the grid axis nearest its normal, primed.
  const counted = whole ? axis : nearestAxis(basis.normal);
  const sliceHelp = useId();
  return (
    // biome-ignore lint/a11y/useSemanticElements: an interactive image surface, not a form fieldset.
    <div
      ref={host}
      data-slice-pane
      className={PANE}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: the pane takes arrow keys to step slices.
      tabIndex={0}
      role="group"
      aria-label={whole ? `Slice ${index + 1} of ${total}` : "Turned slice"}
      aria-describedby={sliceHelp}
    >
      <div
        className={cx(CHIP, "pointer-events-auto top-12 left-2 flex items-center gap-1")}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <Button size="sm" variant="ghost" aria-label="Previous slice" onClick={() => step(-1)}>
          −
        </Button>
        {Math.round(point[counted]) + 1}
        {!whole && "′"} / {scene.shapeZyx[counted]}
        {scale && scale > 1 && <span className="ml-2">1:{scale}</span>}
        <Button size="sm" variant="ghost" aria-label="Next slice" onClick={() => step(1)}>
          +
        </Button>
      </div>
      <span id={sliceHelp} className={cx(CHIP, "top-2 left-2")}>
        Focus slice: ↑/↓ 1 · Page Up/Down 10
      </span>
      {(!shown || refining) && !error && (
        <span className={cx(CHIP, "top-24 right-2 left-2")} role="status">
          {shown ? "Loading full resolution…" : "Loading…"}
        </span>
      )}
      {error && (
        <span className={cx(CHIP, "top-24 right-2 left-2")} role="alert">
          Couldn't load this slice: {error}
        </span>
      )}
      {traceError && (
        <span className={cx(CHIP, "top-24 right-2 left-2")} role="alert">
          {traceError}
        </span>
      )}
      {readout && (
        <span
          className={cx(CHIP, "whitespace-nowrap")}
          style={{ [readout.left ? "left" : "right"]: readout.x + 14, top: readout.y + 14 }}
        >
          {readout.text}
        </span>
      )}
    </div>
  );
}

/** The same object while its value is the same, so effects keyed on it run only on a change. */
function useStable<T>(value: T): T {
  const ref = useRef(value);
  if (JSON.stringify(ref.current) !== JSON.stringify(value)) ref.current = value;
  return ref.current;
}
