/**
 * The grid viewer's 3D pane: the image as a volume rendering with the scene's meshes in it, in
 * the grid's own mm (voxel × spacing; the grid's rotation into the scan is not applied). Drag
 * rotates, right drag pans, the wheel zooms; a click on a mesh moves the crosshair there. Loading
 * the volume or meshes never moves the camera.
 *
 * With Point, a click marks the visible surface under the pointer (the first shown mesh, or the
 * volume where it becomes half opaque, whichever is nearer) and a ring shows where it would land;
 * a click on empty space does nothing. With Line, a drag from one surface point to another marks
 * the line between them; a drag that starts off the surface still rotates. Marks draw over
 * the anatomy (`marks.ts`).
 *
 * Each frame renders the meshes into a target with depth, copies it to the canvas, then
 * ray-marches the volume over it, stopping each ray at the meshes' depth (`volume.ts`).
 */
import { cx } from "@voluma/ui";
import { useEffect, useRef, useState } from "react";
import {
  AmbientLight,
  CylinderGeometry,
  DepthTexture,
  DirectionalLight,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  OrthographicCamera,
  PerspectiveCamera,
  PlaneGeometry,
  type Ray,
  Raycaster,
  Scene,
  SphereGeometry,
  Vector2,
  Vector3,
  WebGLRenderer,
  WebGLRenderTarget,
} from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import type { Contrast } from "./compose";
import { loadMesh, makePickable } from "./geometry";
import { lengthMm, useMarkLayer, wholeShape } from "./marks";
import { CHIP, PANE } from "./pane-style";
import { readLevel } from "./planes";
import {
  type AssetLevel,
  capturePane,
  type GridMark,
  type GridMesh,
  type GridScene,
  type MarkTool,
  type PaneHandle,
  type PaneStatus,
  type ShownMark,
  type Zyx,
} from "./scene";
import { tokenColor } from "./token-color";
import { volumeBytes, volumeLevel, volumeMesh, volumeSteps } from "./volume";

export function Grid3D({
  scene,
  contrast,
  onPoint,
  handle,
  onStatus,
  tool,
  marks,
  onMark,
}: {
  scene: GridScene;
  contrast: Contrast | null;
  onPoint(point: Zyx): void;
  /** Point and Line mark here; Box and Outline are drawn on a slice. */
  tool: MarkTool | null;
  marks: readonly ShownMark[];
  onMark(mark: GridMark): void;
  /** Set while the pane is mounted, for screenshots. */
  handle: { current: PaneHandle | null };
  onStatus(status: PaneStatus): void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const three = useRef<{
    meshes: Group;
    annotations: Scene;
    volumes: Scene;
    depth: DepthTexture;
    render(): void;
  } | null>(null);
  const [meshLoad, setMeshLoad] = useState<{ left: number; error?: string }>({ left: 0 });
  const [volumeLoad, setVolumeLoad] = useState<{ loading: boolean; error?: string }>({
    loading: true,
  });
  const latest = useRef(onPoint);
  latest.current = onPoint;
  const marking = useRef({ tool, marks, onMark });
  marking.current = { tool, marks, onMark };
  // The camera as last drawn: the mark layer projects with it between frames.
  const eye = useRef<PerspectiveCamera | null>(null);
  // The volume as drawn, for finding where a ray meets it.
  const drawn = useRef<{ bytes: Uint8Array; level: AssetLevel } | null>(null);
  const [sz, sy, sx] = scene.spacingZyx;
  const toWorld = (p: Zyx) => new Vector3(p[2] * sx, p[1] * sy, p[0] * sz);
  const layer = useMarkLayer(
    host,
    () => {
      const camera = eye.current;
      const canvas = host.current;
      if (!camera || !canvas) return null;
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      const projected = new Vector3();
      return {
        project: (p) => {
          projected.copy(toWorld(p)).project(camera);
          if (projected.z < -1 || projected.z > 1) return null;
          return [((projected.x + 1) / 2) * width, ((1 - projected.y) / 2) * height];
        },
        shapeOf: wholeShape,
      };
    },
    tool,
    marks,
  );

  useEffect(() => {
    const element = host.current!;
    const renderer = new WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(globalThis.devicePixelRatio);
    renderer.setClearColor(tokenColor("--viewer-well"));
    renderer.domElement.className = "absolute inset-0";
    element.append(renderer.domElement);
    const s = new Scene();
    const camera = new PerspectiveCamera(30, 1, 0.01, 1000);
    eye.current = camera;
    // Array z runs down the screen, as in the slice panes.
    camera.up.set(0, 0, -1);
    const size = toWorld(scene.shapeZyx);
    const center = size.clone().multiplyScalar(0.5);
    const radius = size.length() / 2;
    camera.position
      .copy(center)
      .add(new Vector3(1.2, 2.2, -0.8).normalize().multiplyScalar(radius * 3.6));
    const light = new DirectionalLight(0xffffff, 2.2);
    camera.add(light);
    light.position.set(0.3, 0.6, 1);
    s.add(camera, new AmbientLight(0xffffff, 0.9));
    const meshes = new Group();
    s.add(meshes);
    // The meshes' colour and depth; the volume pass reads the depth.
    const depth = new DepthTexture(1, 1);
    const target = new WebGLRenderTarget(1, 1, { depthTexture: depth, samples: 4 });
    const copy = new Scene();
    copy.add(
      new Mesh(
        new PlaneGeometry(2, 2),
        new MeshBasicMaterial({ map: target.texture, depthTest: false, depthWrite: false }),
      ),
    );
    const flat = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const volumes = new Scene();
    const annotations = new Scene();
    const size2 = new Vector2();
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.copy(center);
    controls.enableDamping = false;
    // One frame per animation frame, however many changes asked for it.
    let frame = 0;
    const draw = () => {
      frame = 0;
      renderer.setRenderTarget(target);
      renderer.render(s, camera);
      renderer.setRenderTarget(null);
      renderer.render(copy, flat);
      renderer.getDrawingBufferSize(size2);
      for (const child of volumes.children) {
        const v = child as ReturnType<typeof volumeMesh>;
        v.updateMatrixWorld();
        const u = v.material.uniforms;
        u.cameraLocal!.value.copy(v.worldToLocal(camera.position.clone()));
        u.localToView!.value.multiplyMatrices(camera.matrixWorldInverse, v.matrixWorld);
        u.resolution!.value.copy(size2);
        u.near!.value = camera.near;
        u.far!.value = camera.far;
      }
      renderer.autoClear = false;
      renderer.render(volumes, camera);
      renderer.clearDepth();
      renderer.render(annotations, camera);
      renderer.autoClear = true;
      layer.draw();
    };
    const render = () => {
      frame ||= requestAnimationFrame(draw);
    };
    controls.addEventListener("change", render);
    controls.update();
    three.current = { meshes, annotations, volumes, depth, render };
    const xyz = (v: Vector3): [number, number, number] => [v.x, v.y, v.z];
    handle.current = {
      capture: () => ({
        ...capturePane(renderer.domElement, draw),
        view: {
          camera: {
            position: xyz(camera.position),
            target: xyz(controls.target),
            up: xyz(camera.up),
          },
        },
      }),
      layers: () => layer.layers(renderer.domElement, draw),
      show(saved) {
        if (!("camera" in saved)) return;
        camera.position.set(...saved.camera.position);
        camera.up.set(...saved.camera.up);
        controls.target.set(...saved.camera.target);
        controls.update();
        render();
      },
    };
    const observer = new ResizeObserver(() => {
      const { width, height } = element.getBoundingClientRect();
      if (!width || !height) return;
      renderer.setSize(width, height);
      renderer.getDrawingBufferSize(size2);
      target.setSize(size2.x, size2.y);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      render();
    });
    observer.observe(element);

    // A left click (not a drag) on a mesh moves the crosshair to the voxel under it: the first
    // opaque mesh, so a structure inside a see-through bone shell wins over the shell. With Point,
    // the press is the mark layer's gesture, so Esc or another tool drops it.
    let downAt: { x: number; y: number; pointerId: number } | null = null;
    const rayAt = (event: { clientX: number; clientY: number }) => {
      const rect = element.getBoundingClientRect();
      const ray = new Raycaster();
      ray.setFromCamera(
        new Vector2(
          ((event.clientX - rect.left) / rect.width) * 2 - 1,
          -((event.clientY - rect.top) / rect.height) * 2 + 1,
        ),
        camera,
      );
      return ray;
    };
    // The visible surface under the pointer, in source voxels (between centres), or null.
    const surfaceAt = (event: { clientX: number; clientY: number }): Zyx | null => {
      const ray = rayAt(event);
      const hit = ray
        .intersectObjects(meshes.children, true)
        .find(
          (h) =>
            h.object.visible && ((h.object as Mesh).material as MeshStandardMaterial).opacity > 0,
        );
      const v = drawn.current;
      const inVolume = v && volumeHit(ray.ray, v, scene.spacingZyx, hit?.distance ?? Infinity);
      const at = inVolume ?? hit?.point;
      if (!at) return null;
      // To 0.01 voxel: finer says nothing and only lengthens the message.
      const voxel = (n: number, size: number) =>
        Math.round(Math.max(0, Math.min(size - 1, n)) * 100) / 100;
      return [
        voxel(at.z / sz, scene.shapeZyx[0]),
        voxel(at.y / sy, scene.shapeZyx[1]),
        voxel(at.x / sx, scene.shapeZyx[2]),
      ];
    };
    const down = (event: PointerEvent) => {
      downAt =
        event.button === 0 && !event.shiftKey && !event.ctrlKey && !event.metaKey
          ? { x: event.clientX, y: event.clientY, pointerId: event.pointerId }
          : null;
      if (downAt && marking.current.tool === "point") layer.start(event, false);
    };
    const up = (event: PointerEvent) => {
      const start = downAt;
      downAt = null;
      const clicked =
        start &&
        event.pointerId === start.pointerId &&
        Math.hypot(event.clientX - start.x, event.clientY - start.y) <= 3;
      const tool = marking.current.tool;
      if (tool === "point") {
        if (!layer.owns(event)) return;
        layer.cancel();
        if (!clicked) return;
        const at = surfaceAt(event);
        if (!at) return;
        const voxel = at.map(Math.round) as [number, number, number];
        marking.current.onMark({ point: voxel });
        latest.current(voxel);
        return;
      }
      if (!clicked || tool) return;
      const ray = rayAt(event);
      const hits = ray.intersectObjects(meshes.children, true).filter((h) => h.object.visible);
      const opaque = (h: (typeof hits)[number]) =>
        ((h.object as Mesh).material as MeshStandardMaterial).opacity >= 1;
      const hit = hits.find(opaque) ?? hits[0];
      if (!hit) return;
      const v = hit.point;
      const clamp = (n: number, axisSize: number) =>
        Math.max(0, Math.min(axisSize - 1, Math.round(n)));
      latest.current([
        clamp(v.z / sz, scene.shapeZyx[0]),
        clamp(v.y / sy, scene.shapeZyx[1]),
        clamp(v.x / sx, scene.shapeZyx[2]),
      ]);
    };
    renderer.domElement.addEventListener("pointerdown", down);
    renderer.domElement.addEventListener("pointerup", up);

    // Line: a drag that starts on the surface draws instead of rotating. Captured on the pane,
    // so the orbit controls on the canvas below never see the press.
    let line: { from: Zyx } | null = null;
    const lineDown = (event: PointerEvent) => {
      if (
        line ||
        marking.current.tool !== "line" ||
        event.button !== 0 ||
        event.shiftKey ||
        event.ctrlKey ||
        event.metaKey
      )
        return;
      const from = surfaceAt(event);
      if (!from) return;
      event.stopPropagation();
      downAt = null;
      layer.start(event);
      line = { from };
      layer.hover = null;
    };
    // Hover and a line's free end follow the pointer, one surface search per frame.
    let pending: PointerEvent | null = null;
    let searching = 0;
    const lineMove = (event: PointerEvent) => {
      const tool = marking.current.tool;
      if (downAt && Math.hypot(event.clientX - downAt.x, event.clientY - downAt.y) > 3)
        downAt = null;
      if (line && !layer.owns(event)) return;
      if (!line && (event.buttons || (tool !== "point" && tool !== "line"))) return;
      pending = event;
      searching ||= requestAnimationFrame(() => {
        searching = 0;
        const at = pending && surfaceAt(pending);
        pending = null;
        if (line) {
          layer.draft = at
            ? {
                line: {
                  aZyx: [...line.from],
                  bZyx: [...at],
                  lengthMm: lengthMm(line.from, at, scene.spacingZyx),
                },
              }
            : null;
        } else layer.hover = at;
        layer.redraw();
      });
    };
    // Whatever ends a gesture (`MarkLayer.cancel`) drops its line, click and pending search.
    const stopReset = layer.onCancel(() => {
      cancelAnimationFrame(searching);
      searching = 0;
      pending = null;
      downAt = null;
      line = null;
    });
    // A release keeps the line.
    const lineUp = (event: PointerEvent) => {
      if (!line || !layer.owns(event)) return;
      event.stopPropagation();
      // Resolve the release itself, not the last animation frame or last valid surface hit.
      const from = line.from;
      const at = surfaceAt(event);
      layer.cancel();
      if (at) {
        const length = lengthMm(from, at, scene.spacingZyx);
        if (length > 0)
          marking.current.onMark({ line: { aZyx: [...from], bZyx: [...at], lengthMm: length } });
      }
    };
    const leave = () => {
      pending = null;
      if (!layer.hover) return;
      layer.hover = null;
      layer.redraw();
    };
    element.addEventListener("pointerdown", lineDown, { capture: true });
    element.addEventListener("pointermove", lineMove);
    element.addEventListener("pointerup", lineUp, { capture: true });
    element.addEventListener("pointerleave", leave);
    return () => {
      stopReset();
      element.removeEventListener("pointerdown", lineDown, { capture: true });
      element.removeEventListener("pointermove", lineMove);
      element.removeEventListener("pointerup", lineUp, { capture: true });
      element.removeEventListener("pointerleave", leave);
      cancelAnimationFrame(frame);
      observer.disconnect();
      controls.dispose();
      for (const root of [s, copy, volumes])
        root.traverse((object) => {
          if (object instanceof Mesh) {
            object.geometry.dispose();
            object.material.uniforms?.volume?.value.dispose();
            object.material.dispose();
          }
        });
      target.dispose();
      renderer.forceContextLoss();
      renderer.dispose();
      renderer.domElement.remove();
      eye.current = null;
      three.current = null;
      handle.current = null;
    };
  }, []);

  useEffect(() => {
    const t = three.current;
    if (!t) return;
    const radius = toWorld(scene.shapeZyx).length() * 0.002;
    const objects: Mesh[] = [];
    for (const a of scene.annotations) {
      if (a.opacity <= 0) continue;
      const material = new MeshBasicMaterial({
        color: a.color,
        opacity: a.opacity,
        transparent: a.opacity < 1,
      });
      const points = a.points.map(toWorld);
      for (const p of points) {
        const dot = new Mesh(new SphereGeometry(radius * 2, 12, 8), material);
        dot.position.copy(p);
        objects.push(dot);
      }
      if (points.length === 2) {
        const [a, b] = points as [Vector3, Vector3];
        const direction = b.clone().sub(a);
        const line = new Mesh(
          new CylinderGeometry(radius, radius, direction.length(), 8),
          material,
        );
        line.position.copy(a).add(b).multiplyScalar(0.5);
        line.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), direction.normalize());
        objects.push(line);
      }
    }
    // add() with nothing logs an error.
    if (objects.length) t.annotations.add(...objects);
    t.render();
    return () => {
      for (const object of objects) {
        t.annotations.remove(object);
        object.geometry.dispose();
        (object.material as MeshBasicMaterial).dispose();
      }
      t.render();
    };
  }, [scene.annotations]);

  // Meshes load once each; a scene change adds or drops only what changed, and colour or
  // opacity changes repaint the loaded ones.
  const meshIds = scene.meshes.map((m) => m.id).join("\n");
  const latestMeshes = useRef(scene.meshes);
  latestMeshes.current = scene.meshes;
  useEffect(() => {
    const t = three.current;
    if (!t) return;
    for (const m of scene.meshes) {
      const mesh = t.meshes.getObjectByName(m.id);
      if (mesh instanceof Mesh) paint(mesh, m);
    }
    t.render();
  }, [scene.meshes]);
  useEffect(() => {
    const t = three.current;
    if (!t) return;
    const abort = new AbortController();
    const wanted = new Map(latestMeshes.current.map((m) => [m.id, m]));
    for (const child of [...t.meshes.children]) {
      if (wanted.has(child.name)) continue;
      t.meshes.remove(child);
      if (child instanceof Mesh) {
        child.geometry.dispose();
        child.material.dispose();
      }
    }
    const missing = latestMeshes.current.filter((m) => !t.meshes.getObjectByName(m.id));
    setMeshLoad({ left: missing.length });
    const settle = (error?: string) => {
      if (!abort.signal.aborted)
        setMeshLoad((had) => ({ left: had.left - 1, error: had.error ?? error }));
    };
    for (const m of missing)
      loadMesh(m, abort.signal)
        .then((geometry) => {
          const material = new MeshStandardMaterial({
            roughness: 0.75,
            metalness: 0,
            side: DoubleSide,
          });
          const mesh = new Mesh(geometry, material);
          makePickable(mesh);
          mesh.name = m.id;
          // Vertices are voxel (x, y, z), in crop voxels for a cropped mask.
          mesh.scale.set(sx, sy, sz);
          mesh.position.copy(toWorld(m.offsetZyx));
          paint(mesh, latestMeshes.current.find((l) => l.id === m.id) ?? m);
          t.meshes.add(mesh);
          t.render();
          settle();
        })
        .catch((cause) => settle(`Couldn't load the ${m.name} mesh: ${(cause as Error).message}`));
    return () => abort.abort();
  }, [meshIds]);

  // The volume: the coarsest level at once, then the finest that fits (`volumeLevel`); the raw
  // values are kept so a contrast change only rebuilds the bytes. Keyed by the asset, not the
  // object: Review rebuilds the scene on every display change.
  const [levels, setLevels] = useState<{ k: number; values: ArrayLike<number> }[]>([]);
  useEffect(() => {
    const abort = new AbortController();
    const { base, levels: all } = scene.image;
    const coarsest = all.length - 1;
    const target = volumeLevel(all);
    setVolumeLoad({ loading: true });
    (async () => {
      for (const k of target === coarsest ? [coarsest] : [coarsest, target]) {
        const { data } = await readLevel(base, all[k]!.path, abort.signal);
        setLevels((had) => [...had.filter((l) => l.k !== k), { k, values: data }]);
      }
      setVolumeLoad({ loading: false });
    })().catch((cause) => {
      if (!abort.signal.aborted)
        setVolumeLoad({
          loading: false,
          error: `Couldn't load the volume: ${(cause as Error).message}`,
        });
    });
    return () => abort.abort();
  }, [scene.image.base]);
  const shown = levels.reduce<(typeof levels)[number] | undefined>(
    (best, l) => (!best || l.k < best.k ? l : best),
    undefined,
  );
  useEffect(() => {
    const t = three.current;
    if (!t || !shown || !contrast) return;
    const bytes = volumeBytes(shown.values, contrast);
    const volume = volumeMesh(
      bytes,
      scene.image.levels[shown.k]!,
      scene.spacingZyx,
      tokenColor("--bone"),
      t.depth,
    );
    t.volumes.add(volume);
    drawn.current = { bytes, level: scene.image.levels[shown.k]! };
    t.render();
    return () => {
      drawn.current = null;
      t.volumes.remove(volume);
      volume.geometry.dispose();
      volume.material.uniforms.volume!.value.dispose();
      volume.material.dispose();
      t.render();
    };
  }, [shown, contrast]);

  const chip =
    volumeLoad.error ??
    (volumeLoad.loading
      ? "Loading the volume…"
      : (meshLoad.error ??
        (meshLoad.left > 0
          ? `Loading ${meshLoad.left} mesh${meshLoad.left > 1 ? "es" : ""}…`
          : undefined)));
  // A missing surface is missing content; the finer volume only sharpens the coarsest one.
  const status: PaneStatus =
    (!shown && !volumeLoad.error) || meshLoad.left > 0
      ? "loading"
      : volumeLoad.loading
        ? "refining"
        : volumeLoad.error || meshLoad.error
          ? "failed"
          : "ready";
  const latestStatus = useRef(onStatus);
  latestStatus.current = onStatus;
  useEffect(() => latestStatus.current(status), [status]);
  return (
    <div ref={host} className={PANE}>
      {chip && (
        <span className={cx(CHIP, "top-2 right-2")} role="status">
          {chip}
        </span>
      )}
    </div>
  );
}

function paint(mesh: Mesh, m: GridMesh) {
  const material = mesh.material as MeshStandardMaterial;
  material.color.set(m.color);
  material.opacity = m.opacity;
  material.transparent = m.opacity < 1;
  material.depthWrite = m.opacity >= 1;
  material.needsUpdate = true;
  mesh.visible = m.opacity > 0;
  // Draw see-through shells after what they contain.
  mesh.renderOrder = m.opacity < 1 ? 1 : 0;
}

/**
 * Where `ray` (grid mm) first meets the volume as `volume.ts` draws it: half opaque, with the
 * shader's byte texture, linear filtering and step count. Null if it stays clear before the
 * first shown mesh (`before`); point marking deliberately includes translucent shells.
 */
function volumeHit(
  ray: Ray,
  volume: { bytes: Uint8Array; level: AssetLevel },
  spacingZyx: Zyx,
  before: number,
): Vector3 | null {
  const { bytes, level } = volume;
  const [nz, ny, nx] = level.shapeZyx;
  const [kz, ky, kx] = level.scaleZyx;
  const [sz, sy, sx] = spacingZyx;
  // Level voxel j spans source [j·k − ½, (j+1)·k − ½), in mm × spacing (world x, y, z).
  const lo = new Vector3(-0.5 * sx, -0.5 * sy, -0.5 * sz);
  const hi = new Vector3((nx * kx - 0.5) * sx, (ny * ky - 0.5) * sy, (nz * kz - 0.5) * sz);
  let tNear = 0;
  let tFar = before;
  for (const axis of ["x", "y", "z"] as const) {
    const o = ray.origin[axis];
    const d = ray.direction[axis];
    if (Math.abs(d) < 1e-12) {
      if (o < lo[axis] || o > hi[axis]) return null;
      continue;
    }
    const t0 = (lo[axis] - o) / d;
    const t1 = (hi[axis] - o) / d;
    tNear = Math.max(tNear, Math.min(t0, t1));
    tFar = Math.min(tFar, Math.max(t0, t1));
  }
  if (tFar <= tNear) return null;
  // Same midpoint samples and unit-box opacity exponent as the shader, including anisotropy.
  const steps = volumeSteps(level.shapeZyx);
  const step = (tFar - tNear) / steps;
  const d = ray.direction;
  const exponent =
    Math.hypot(
      (d.x * step) / (nx * kx * sx),
      (d.y * step) / (ny * ky * sy),
      (d.z * step) / (nz * kz * sz),
    ) / Math.hypot(1 / nx, 1 / ny, 1 / nz);
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
  const sample = (x: number, y: number, z: number) => bytes[(z * ny + y) * nx + x]! / 255;
  const p = new Vector3();
  let alpha = 0;
  for (let i = 0; i < steps; i++) {
    ray.at(tNear + (i + 0.5) * step, p);
    // Texture coordinates address texel centres; edges clamp just like Data3DTexture.
    const x = Math.max(0, Math.min(nx - 1, (p.x / sx + 0.5) / kx - 0.5));
    const y = Math.max(0, Math.min(ny - 1, (p.y / sy + 0.5) / ky - 0.5));
    const z = Math.max(0, Math.min(nz - 1, (p.z / sz + 0.5) / kz - 0.5));
    const x0 = Math.floor(x),
      x1 = Math.min(x0 + 1, nx - 1);
    const y0 = Math.floor(y),
      y1 = Math.min(y0 + 1, ny - 1);
    const z0 = Math.floor(z),
      z1 = Math.min(z0 + 1, nz - 1);
    const v = lerp(
      lerp(
        lerp(sample(x0, y0, z0), sample(x1, y0, z0), x - x0),
        lerp(sample(x0, y1, z0), sample(x1, y1, z0), x - x0),
        y - y0,
      ),
      lerp(
        lerp(sample(x0, y0, z1), sample(x1, y0, z1), x - x0),
        lerp(sample(x0, y1, z1), sample(x1, y1, z1), x - x0),
        y - y0,
      ),
      z - z0,
    );
    const e = Math.max(0, Math.min(1, (v - 0.22) / (0.6 - 0.22)));
    const a = e * e * (3 - 2 * e);
    if (a <= 0) continue;
    alpha += (1 - alpha) * (1 - (1 - a * 0.6) ** exponent);
    if (alpha >= 0.5) return p.clone();
  }
  return null;
}
