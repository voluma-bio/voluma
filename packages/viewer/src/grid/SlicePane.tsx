/**
 * One slice pane of the grid viewer: the plane through the crosshair with normal `basis.normal`,
 * drawn by three.js with an orthographic camera in pane mm (`basis.right` across, `basis.down`
 * down). Untilted (the grid's own axes, the default), it reads whole slices of the grid, opening
 * on the coarsest level and refining to the level the zoom needs. Tilted, it is resliced in the
 * browser from the level the 3D pane loads (`reslice.ts`), so it is softer. Left drag moves the
 * crosshair, the wheel steps slices along the normal, Ctrl or ⌘ + wheel zooms at the pointer,
 * Shift, middle or right drag pans. With `onTilt`, the dots near both ends of the other planes'
 * crosshair lines turn those planes about this pane's normal; this pane stays still.
 *
 * With a marking tool, left click or drag marks instead (`marks.ts` draws them): Point a voxel
 * (and the crosshair moves to it), Box a drag's rectangle, Line a drag's two ends or two clicks,
 * Angle three clicks (the vertex second), Outline a freehand loop, Probe reads the value under the
 * pointer and keeps it as a point on click. Esc drops a mark being drawn.
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
import { type Contrast, compose, composeSampled, type OverlayPlane } from "./compose";
import {
  angleAbout,
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
import {
  angleDegrees,
  areaMm2,
  lengthMm,
  probeText,
  sliceShape,
  thin,
  useMarkLayer,
} from "./marks";
import { CHIP, PANE } from "./pane-style";
import { corners, quad, texture } from "./picture";
import { type Plane, readPlane, sharedLevel } from "./planes";
import { type Level3, resample, sampling, samplingCorners, valueAt, voxelAt } from "./reslice";
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
  type ProbeValue,
  planeAxes,
  type ShownMark,
  type Zyx,
} from "./scene";
import { tokenColor } from "./token-color";
import { volumeLevel } from "./volume";

/** The colour token of the plane holding `axis` constant, when the caller gives none. */
export const axisToken = (axis: Axis) =>
  axis === 0 ? "--axis-z" : axis === 1 ? "--axis-y" : "--axis-x";

/** Another plane through the crosshair, drawn as a line across this pane in its colour. */
export type Cut = { axis: Axis; normal: Vec3; token?: string };

/** Pixels per mm, the zoom that fits the grid in the pane, and the pane centre in mm. */
type View = { zoom: number; fit: number; center: [number, number] };

/** A drag shorter than this (CSS px) is a click. */
const CLICK_PX = 4;
/** An outline takes a point when the pointer has moved this far (CSS px) since the last. */
const OUTLINE_STEP_PX = 3;
/** The contract's cap on an outline's points. */
const OUTLINE_MAX = 500;
/** How near a tilt handle a press must land (CSS px), and how far out the handles sit (of the pane's half size). */
const HANDLE_HIT_PX = 9;
const HANDLE_REACH = 0.85;

/** What a probe reads at a source voxel, from what the pane has loaded. */
type Probe = (p: Zyx) => ProbeValue | null;

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
  note,
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
  /** Turns the cut planes by `angle` radians about this pane's normal; absent, no handles. */
  onTilt?(angle: number): void;
  /** A point waiting for its note: a field at the point, Enter keeps the text, Esc none. */
  note?: { at: Zyx; done(text: string | null): void };
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
  const noteField = useRef<HTMLInputElement>(null);
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
    key: string;
    level: number;
    contrast: Contrast;
    overlays: GridScene["overlays"];
  } | null>(null);
  const [error, setError] = useState<string>();
  const [traceError, setTraceError] = useState<string>();
  const [traces, setTraces] = useState<Map<string, BufferGeometry>>(new Map());
  // `x` from the pane's left, or (`left` false: the pointer is in its right half) its right.
  const [readout, setReadout] = useState<{
    x: number;
    y: number;
    left: boolean;
    text: string;
  } | null>(null);
  const probe = useRef<Probe | null>(null);
  const [hovering, setHovering] = useState(false);

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
    toPane,
    fromPane,
    basis,
    cuts,
    whole,
    slab,
  });
  latest.current = {
    point,
    onPoint,
    onStatus,
    tool,
    marks,
    onMark,
    onTilt,
    toPane,
    fromPane,
    basis,
    cuts,
    whole,
    slab,
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
  showHandles.current = hovering && !tool && !!onTilt;

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
  );
  useEffect(() => layer.redraw(), [hovering, tool, layer]);

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
    const cross = new LineSegments(
      new BufferGeometry(),
      new LineBasicMaterial({ vertexColors: true, depthTest: false }),
    );
    cross.renderOrder = 1;
    const drawings = new Group();
    sc.add(image, cross, drawings);
    const state = {
      renderer,
      camera,
      scene: sc,
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
      renderer.render(sc, camera);
      layer.draw();
      placeNote();
    };
    const [rows, cols] = [scene.shapeZyx[ra] * s[ra], scene.shapeZyx[ca] * s[ca]];
    const fitZoom = (width: number, height: number) => Math.min(width / cols, height / rows) * 0.95;
    three.current = state;
    const now = (): PaneView => {
      const v = view.current!;
      return { zoom: v.zoom / v.fit, center: [v.center[0], v.center[1]] };
    };
    handle.current = {
      capture: () => ({ ...capturePane(renderer.domElement, paint), view: now() }),
      view: now,
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
        center:
          pending.current?.center ??
          latest.current.toPane(scene.shapeZyx.map((n) => (n - 1) / 2) as unknown as Zyx),
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
        new LineBasicMaterial({ color, opacity, transparent: opacity < 1, depthTest: false }),
      );
      object.renderOrder = 2;
      objects.push(object);
    };
    const dotSize = Math.max(s[ra], s[ca]) * 2;
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
          new CircleGeometry(dotSize, 12),
          new MeshBasicMaterial({
            color: a.color,
            opacity: a.opacity,
            transparent: a.opacity < 1,
            depthTest: false,
          }),
        );
        dotMesh.position.set(...toPane(p), 2);
        dotMesh.renderOrder = 2;
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

  // A tilted pane reslices whole levels: the image's that 3D loads, and each overlay's nearest
  // to it, no finer. Read once a pane tilts; shared with every pane and the 3D pane.
  const [volumes, setVolumes] = useState<{
    image: Level3;
    scale: number;
    overlays: Map<string, Level3>;
  }>();
  const [volumeError, setVolumeError] = useState<string>();
  const overlayKey = scene.overlays.map((o) => `${o.base}|${o.levels[0]?.path}`).join("\n");
  const latestOverlays = useRef(scene.overlays);
  latestOverlays.current = scene.overlays;
  useEffect(() => {
    if (whole) return;
    let gone = false;
    const imageLevel = scene.image.levels[volumeLevel(scene.image.levels)]!;
    const level3 = (data: Plane, l: typeof imageLevel, offset: Zyx): Level3 => ({
      data: data.data,
      shape: l.shapeZyx,
      scale: l.scaleZyx,
      offset,
    });
    Promise.all([
      sharedLevel(scene.image.base, imageLevel.path),
      ...latestOverlays.current.map(async (o) => {
        const l =
          o.levels.find((x) => Math.max(...x.scaleZyx) >= Math.max(...imageLevel.scaleZyx)) ??
          o.levels.at(-1)!;
        return [o.base, level3(await sharedLevel(o.base, l.path), l, o.offsetZyx)] as const;
      }),
    ])
      .then(([image, ...overlays]) => {
        if (gone) return;
        setVolumes({
          image: level3(image as Plane, imageLevel, [0, 0, 0]),
          scale: Math.max(...imageLevel.scaleZyx),
          overlays: new Map(overlays as (readonly [string, Level3])[]),
        });
        setVolumeError(undefined);
      })
      .catch((cause) => {
        if (!gone) setVolumeError((cause as Error).message);
      });
    return () => {
      gone = true;
    };
  }, [whole, scene.image.base, overlayKey]);

  // Untilted: load the slice through the crosshair at the level the zoom needs. The coarsest
  // level shows meanwhile, unless the finer one arrives almost as soon (it does from the
  // worker's cache).
  useEffect(() => {
    if (!contrast || !whole) return;
    const abort = new AbortController();
    const load = async (k: number) => {
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
      return { picture, read };
    };
    // Whether this effect drew a picture of the requested slice; if none, the old one goes.
    let current = false;
    const show = (made: Awaited<ReturnType<typeof load>>, k: number) => {
      if (!made || abort.signal.aborted) return;
      const { picture, read } = made;
      draw(picture.rgba, picture.cols, picture.rows, corners(picture).map(toPane), false);
      probe.current = read;
      setShown({ key: planeKey, level: k, contrast, overlays: scene.overlays });
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
  }, [index, level, contrast, axis, scene.overlays, whole]);

  // Tilted: reslice the plane through the crosshair from the whole levels.
  useEffect(() => {
    if (!contrast || whole || !volumes) return;
    const step = Math.min(...volumes.image.scale.map((v, k) => v * s[k]!));
    const at = sampling(basis, point, s, scene.shapeZyx, step);
    const image = resample(volumes.image, at, basis, s, false);
    const layers = scene.overlays.flatMap((overlay) => {
      const level = volumes.overlays.get(overlay.base);
      return level ? [{ overlay, values: resample(level, at, basis, s, true), level }] : [];
    });
    draw(composeSampled(image, contrast, layers), at.cols, at.rows, samplingCorners(at), true);
    probe.current = (p) => {
      const value = valueAt(volumes.image, p);
      if (value === null) return null;
      const inside = layers.filter((l) => voxelAt(l.level, p)).map((l) => l.overlay.name);
      return { value, unit: scene.imageUnit ?? null, approx: true, inside };
    };
    setShown({ key: planeKey, level: -1, contrast, overlays: scene.overlays });
    setError(undefined);
  }, [planeKey, contrast, volumes, scene.overlays, whole]);

  function draw(
    rgba: Uint8Array,
    cols: number,
    rows: number,
    at: [number, number][],
    smooth: boolean,
  ) {
    const t = three.current;
    if (!t) return;
    t.image.geometry.dispose();
    t.image.geometry = quad(at.map(([x, y]) => [x, y, 0]));
    t.image.material.map?.dispose();
    t.image.material.map = texture({ rgba, cols, rows }, smooth);
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

  // The note field sits at its point, wherever the pane is panned or zoomed.
  function placeNote() {
    const field = noteField.current;
    const at = latestNote.current?.at;
    const v = view.current;
    const element = host.current;
    if (!field || !at || !v || !element) return;
    const [x, y] = latest.current.toPane(at);
    field.style.left = `${(x - v.center[0]) * v.zoom + element.clientWidth / 2 + 12}px`;
    field.style.top = `${(v.center[1] - y) * v.zoom + element.clientHeight / 2 - 12}px`;
  }
  const latestNote = useRef(note);
  latestNote.current = note;
  useEffect(() => {
    if (!note) return;
    placeNote();
    noteField.current?.focus({ preventScroll: true });
  }, [note]);

  // Pointer and wheel.
  useEffect(() => {
    const element = host.current!;
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
    // Where the pointer is on this slice, between voxel centres: a line's or an outline's points.
    const toPosition = (event: { clientX: number; clientY: number }): Zyx => {
      const [x, y] = paneMm(event);
      const { point: at, fromPane: from, whole: w } = latest.current;
      const p = inside(from(x, y, at)).map(hundredths);
      if (w) p[axis] = Math.round(at[axis]);
      return p as unknown as Zyx;
    };
    // Clicks made so far toward a line (two) or an angle (three); the layer's draft shows them.
    let clicks: Zyx[] = [];
    // The gesture's pointer is the mark layer's; the rest of it is the pane's.
    let drag: {
      mode: "cross" | "pan" | "tilt" | MarkTool;
      x: number;
      y: number;
      from: Zyx;
      moved: boolean;
      /** An outline's points, and the screen position of the last. */
      path: Zyx[];
      last: [number, number];
      /** A tilt's direction from the crosshair, in mm, at the last move. */
      toward?: Vec3;
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
    const down = (event: PointerEvent) => {
      if (drag || !view.current) return;
      element.focus({ preventScroll: true });
      const pan = event.button === 1 || event.button === 2 || event.shiftKey;
      const tool = latest.current.tool;
      // A press on a tilt handle turns the other planes.
      const rect = element.getBoundingClientRect();
      const hit =
        !pan && !tool && latest.current.onTilt
          ? handlesNow(rect.width, rect.height).find(
              (h) =>
                Math.hypot(h.x - (event.clientX - rect.left), h.y - (event.clientY - rect.top)) <=
                HANDLE_HIT_PX,
            )
          : undefined;
      layer.start(event);
      const from = toPosition(event);
      drag = {
        mode: pan ? "pan" : hit ? "tilt" : (tool ?? "cross"),
        x: event.clientX,
        y: event.clientY,
        from,
        moved: false,
        path: [from],
        last: [event.clientX, event.clientY],
        ...(hit && { toward: towardPointer(event) }),
      };
      if (drag.mode === "cross") latest.current.onPoint(toVoxel(event));
    };
    const move = (event: PointerEvent) => {
      const tool = latest.current.tool;
      if (!drag) {
        if (tool === "point" || tool === "line" || tool === "angle") {
          layer.hover = toVoxel(event);
          if (clicks.length) layer.draft = clickDraft(tool, toPosition(event));
          layer.redraw();
        }
        if (tool === "probe") showProbe(event);
        return;
      }
      if (!layer.owns(event)) return;
      if (drag.mode === "cross") latest.current.onPoint(toVoxel(event));
      else if (drag.mode === "tilt") {
        const toward = towardPointer(event);
        const angle = angleAbout(drag.toward!, toward, latest.current.basis.normal);
        drag.toward = toward;
        if (angle) latest.current.onTilt?.(angle);
      } else if (drag.mode !== "pan") {
        if (!drag.moved && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < CLICK_PX)
          return;
        drag.moved = true;
        // On the slice the gesture began on, even if the wheel stepped since.
        const to = toPosition(event);
        if (drag.mode === "box") layer.draft = boxMark(round(drag.from), round(to));
        else if (drag.mode === "line" && !clicks.length) {
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
              zyx: drag.path.map((p) => [...p] as unknown as Zyx),
              areaMm2: areaMm2(drag.path, scene.spacingZyx),
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
      const d = drag;
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
      if (d.mode === "cross" || d.mode === "pan" || d.mode === "tilt") return null;
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
    // An untilted pane steps whole slices; a tilted one steps the grid's finest spacing along its normal.
    const step = (by: number) => {
      const { point: at, whole: w, basis: b } = latest.current;
      const p = [...at];
      if (w) p[axis] = clamp(Math.round(p[axis]!) + by, scene.shapeZyx[axis]);
      else {
        const h = Math.min(...scene.spacingZyx) * by;
        for (const k of [0, 1, 2]) p[k] = p[k]! + (h * b.normal[k]!) / scene.spacingZyx[k]!;
        if (p.some((v, k) => v < 0 || v > scene.shapeZyx[k]! - 1)) return;
      }
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
    element.addEventListener("pointerenter", enter);
    element.addEventListener("pointerleave", leave);
    element.addEventListener("wheel", wheel, { passive: false });
    element.addEventListener("keydown", key);
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
      element.removeEventListener("contextmenu", menu);
    };
  }, []);
  useEffect(() => {
    if (tool !== "probe") setReadout(null);
  }, [tool]);

  const total = scene.shapeZyx[axis];
  // Another slice or level on its way: the picture shown is a stand-in.
  const refining = shown && (shown.key !== planeKey || (whole && shown.level !== level));
  // A display change (contrast, overlays) also leaves the picture out of date for a moment.
  const stale =
    refining || (shown && (shown.contrast !== contrast || shown.overlays !== scene.overlays));
  const failed =
    error ?? (whole ? undefined : volumeError && `Couldn't load the volume: ${volumeError}`);
  const status: PaneStatus =
    (!shown && !failed) || (traces.size !== traceMeshes.length && !traceError)
      ? "loading"
      : stale && !failed
        ? "refining"
        : failed || traceError
          ? "failed"
          : "ready";
  useEffect(() => latest.current.onStatus(status), [status]);
  const scale = !shown
    ? null
    : whole
      ? scene.image.levels[shown.level]?.scaleZyx[axis]
      : volumes?.scale;
  // A tilted pane counts along the grid axis nearest its normal, primed.
  const counted = whole ? axis : nearestAxis(basis.normal);
  return (
    <div
      ref={host}
      className={PANE}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: the pane takes arrow keys to step slices.
      tabIndex={0}
      role="img"
      aria-label={whole ? `Slice ${index + 1} of ${total}` : "Tilted slice"}
    >
      <span className={cx(CHIP, "bottom-2 left-2")}>
        {Math.round(point[counted]) + 1}
        {!whole && "′"} / {scene.shapeZyx[counted]}
        {scale && scale > 1 && <span className="ml-2">1:{scale}</span>}
      </span>
      {(!shown || refining) && !failed && (
        <span className={cx(CHIP, "top-2 right-2")} role="status">
          {shown ? "Loading full resolution…" : whole ? "Loading…" : "Loading the volume…"}
        </span>
      )}
      {failed && (
        <span className={cx(CHIP, "top-2 right-2")} role="alert">
          {whole ? `Couldn't load this slice: ${failed}` : failed}
        </span>
      )}
      {traceError && (
        <span className={cx(CHIP, "top-2 right-2")} role="alert">
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
      {note && (
        <input
          ref={noteField}
          aria-label="Note on this point"
          placeholder="Note, then Enter"
          className="absolute z-20 h-6 w-56 rounded-sm border border-mark-mine bg-viewer-chip px-1.5 font-mono text-xs text-viewer-chip-fg outline-none placeholder:text-viewer-chip-fg/60"
          onPointerDown={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === "Enter") note.done(event.currentTarget.value.trim() || null);
            else if (event.key === "Escape") note.done(null);
          }}
          onBlur={(event) => note.done(event.currentTarget.value.trim() || null)}
        />
      )}
    </div>
  );
}

const clamp = (n: number, size: number) => Math.max(0, Math.min(size - 1, n));
const round = (p: Zyx) => p.map(Math.round) as unknown as Zyx;
/** A position to 0.01 voxel: finer says nothing and only lengthens the message. */
const hundredths = (n: number) => Math.round(n * 100) / 100;

/** The same object while its value is the same, so effects keyed on it run only on a change. */
function useStable<T>(value: T): T {
  const ref = useRef(value);
  if (JSON.stringify(ref.current) !== JSON.stringify(value)) ref.current = value;
  return ref.current;
}
