/**
 * The grid viewer's 3D pane: the scene's meshes, or the image as a volume rendering when the
 * scene has none (the scan before segmentation), in the grid's own mm (voxel × spacing; the grid's
 * rotation into the scan is not applied). Drag turns the scene like a ball in any direction, over
 * the top and around the view axis (a drag near the edge rolls); Shift, Ctrl/⌘ or right drag
 * pans; the wheel or middle drag zooms. A click on a mesh moves the crosshair there.
 *
 * The camera opens on the grid's centre from the side of the output's own meshes (`GridMesh.own`),
 * so they sit in front of the see-through context. It turns there each time an output's own
 * meshes have loaded, until a gesture or a restored view has touched the camera; after that,
 * loading the volume or meshes never moves it. The reset button returns to that view for the meshes shown now.
 *
 * With Point, a click marks the visible surface under the pointer (the first shown mesh, or the
 * volume where it becomes half opaque, whichever is nearer) and a ring shows where it would land;
 * a click on empty space does nothing. With Line, a drag from one surface point to another marks
 * the line between them; a drag that starts off the surface still rotates. Marks draw over
 * the anatomy (`marks.ts`).
 *
 * Each frame renders the meshes into a target with depth, copies it to the canvas, then
 * ray-marches the volume, if any, over it (`volume.ts`).
 */
import { Button, cx, IconButton } from "@voluma/ui";
import { RotateCcw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  AmbientLight,
  Box3,
  BufferGeometry,
  CylinderGeometry,
  DepthTexture,
  DirectionalLight,
  DoubleSide,
  FrontSide,
  Group,
  LineBasicMaterial,
  LineLoop,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  type Object3D,
  OrthographicCamera,
  PerspectiveCamera,
  PlaneGeometry,
  type Ray,
  Raycaster,
  Scene,
  Sphere,
  SphereGeometry,
  Vector2,
  Vector3,
  WebGLRenderer,
  WebGLRenderTarget,
} from "three";
import { ArcballControls } from "three/addons/controls/ArcballControls.js";
import type { Contrast } from "./compose";
import { planeOutline, type Vec3 } from "./frame";
import { loadMesh, makePickable } from "./geometry";
import { lengthMm, useMarkLayer, wholeShape } from "./marks";
import { CHIP, PANE } from "./pane-style";
import { holdLevel } from "./planes";
import type {
  AssetLevel,
  GridMark,
  GridMesh,
  GridScene,
  MarkTool,
  PaneHandle,
  PaneStatus,
  ShownMark,
  Zyx,
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
  onPick,
  planes,
}: {
  scene: GridScene;
  /** The slice panes' planes through the crosshair, outlined where they cut the grid; none hides them. */
  planes?: { at: Zyx; cuts: readonly { normal: Vec3; color: string }[] };
  contrast: Contrast | null;
  onPoint(point: Zyx): void;
  /** Point and Line mark here; Box and Outline are drawn on a slice. */
  tool: MarkTool | null;
  marks: readonly ShownMark[];
  onMark(mark: GridMark): void;
  onPick?(id?: string): void;
  /** Set while the pane is mounted, for screenshots. */
  handle: { current: PaneHandle | null };
  onStatus(status: PaneStatus): void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [planesShown, setPlanesShown] = useState(true);
  const three = useRef<{
    meshes: Group;
    annotations: Scene;
    planes: Scene;
    volumes: Scene;
    depth: DepthTexture;
    render(): void;
    reset(): void;
    aim(): void;
  } | null>(null);
  const [meshLoad, setMeshLoad] = useState<{ left: number; error?: string }>({ left: 0 });
  // The raw image is drawn only under no meshes: with them its threshold surface hides them.
  const volumeWanted = scene.meshes.length === 0;
  const [volumeLoad, setVolumeLoad] = useState<{ loading: boolean; error?: string }>({
    loading: volumeWanted,
  });
  const latest = useRef(onPoint);
  latest.current = onPoint;
  const marking = useRef({ tool, marks, onMark, onPick });
  marking.current = { tool, marks, onMark, onPick };
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
    onPick,
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
    const size = toWorld(scene.shapeZyx);
    const center = size.clone().multiplyScalar(0.5);
    const radius = size.length() / 2;
    // Coarse levels pad each axis independently; thin anisotropic grids can extend well
    // beyond the source grid. Include every level's box, as positioned by volumeMesh.
    const bounds = new Box3(toWorld([-0.5, -0.5, -0.5]), size.clone());
    for (const { shapeZyx: shape, scaleZyx: scale } of scene.image.levels) {
      bounds.expandByPoint(
        toWorld([shape[0] * scale[0] - 0.5, shape[1] * scale[1] - 0.5, shape[2] * scale[2] - 0.5]),
      );
    }
    const clip = bounds.getBoundingSphere(new Sphere());
    // The opening view looks at the grid's centre from the side of the output's own meshes, so
    // they sit in front of the see-through context; from a default side when they are near the
    // centre or there are none. Array z runs down the screen, as in the slice panes, unless the
    // view is nearly along z.
    const opening = () => {
      const own = new Box3();
      for (const child of meshes.children)
        if (child.visible && child.userData.own) own.expandByObject(child);
      const offset = own.isEmpty() ? new Vector3() : own.getCenter(new Vector3()).sub(center);
      const direction = (
        offset.length() > radius * 0.05 ? offset : new Vector3(1.2, 2.2, -0.8)
      ).normalize();
      return {
        position: center.clone().add(direction.clone().multiplyScalar(radius * 3.6)),
        target: center,
        up:
          Math.abs(direction.z) > Math.cos((10 * Math.PI) / 180)
            ? new Vector3(0, -1, 0)
            : new Vector3(0, 0, -1),
      };
    };
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
    const planeScene = new Scene();
    const size2 = new Vector2();
    // No scene, so no gizmos; no fling after a drag, no double-click focus.
    const controls = new ArcballControls(camera, renderer.domElement);
    controls.enableAnimations = false;
    controls.enableFocus = false;
    // Its defaults, less FOV on Shift (Shift + wheel or middle drag zooms), plus Shift drag pans.
    controls.unsetMouseAction("WHEEL", "SHIFT");
    controls.unsetMouseAction(1, "SHIFT");
    controls.setMouseAction("PAN", 0, "SHIFT");
    // `target` (untyped in @types/three) is where `setCamera` looks and pivots. The pivot after
    // that is the private gizmo group's position: a pan moves it and leaves `target` behind.
    const arcball = controls as unknown as { target: Vector3; _gizmos: Object3D };
    const pivot = arcball._gizmos.position;
    // One frame per animation frame, however many changes asked for it.
    let frame = 0;
    const draw = () => {
      frame = 0;
      // A hidden pane draws nothing; showing it resizes it, which draws.
      if (!element.clientWidth) return;
      // Distance bounds forward depth even after panning. Keep near fixed: moving it by
      // this distance would clip anatomy still in frame when the camera looks off-centre.
      camera.far = Math.max(
        camera.near * 2,
        camera.position.distanceTo(clip.center) + clip.radius * 1.01,
      );
      camera.updateProjectionMatrix();
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
      renderer.render(planeScene, camera);
      renderer.render(annotations, camera);
      renderer.autoClear = true;
      layer.draw();
    };
    const render = () => {
      frame ||= requestAnimationFrame(draw);
    };
    controls.addEventListener("change", render);
    // Sets the camera from outside; `setCamera` makes the controls continue from it.
    const place = (position: Vector3, target: Vector3, up: Vector3) => {
      camera.position.copy(position);
      camera.up.copy(up);
      arcball.target.copy(target);
      controls.setCamera(camera);
      // Gestures read the pivot from the group's matrix, which nothing renders to refresh, and
      // `setCamera` moves only its position: unrefreshed, a pan or zoom jumps to the origin.
      arcball._gizmos.updateMatrix();
      render();
    };
    const reset = () => {
      const { position, target, up } = opening();
      place(position, target, up);
    };
    reset();
    // The camera turns to face the output whenever its own meshes have loaded, until a gesture or
    // a restored view has touched it.
    let touched = false;
    controls.addEventListener("start", () => {
      touched = true;
    });
    const aim = () => {
      if (!touched) reset();
    };
    three.current = { meshes, annotations, planes: planeScene, volumes, depth, render, reset, aim };
    const xyz = (v: Vector3): [number, number, number] => [v.x, v.y, v.z];
    // Up from the camera's own turn: the controls leave `camera.up` meaningless after a rotate.
    const now = () => ({
      camera: {
        position: xyz(camera.position),
        target: xyz(pivot),
        up: xyz(new Vector3(0, 1, 0).applyQuaternion(camera.quaternion)),
      },
    });
    handle.current = {
      view: now,
      layers: () => layer.layers(renderer.domElement, draw),
      show(saved) {
        if (!("camera" in saved)) return;
        const { position, target, up } = saved.camera;
        touched = true;
        place(new Vector3(...position), new Vector3(...target), new Vector3(...up));
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
      // The ball's size follows the pane's aspect; this also draws.
      controls.setTbRadius(controls.radiusFactor);
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
      // The controls follow the pointer on the window; the release comes back here.
      renderer.domElement.setPointerCapture(event.pointerId);
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
      marking.current.onPick?.(undefined);
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
    // so the controls on the canvas below never see the press.
    let line: { from: Zyx } | null = null;
    const lineDown = (event: PointerEvent) => {
      if ((event.target as HTMLElement).closest("button, input, textarea, select, a")) return;
      if (
        line ||
        event.target !== renderer.domElement ||
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

  // The planes: an outline and a faint fill per pane, rebuilt when the crosshair or a tilt moves them.
  const planesKey = planes && JSON.stringify(planes);
  useEffect(() => {
    const t = three.current;
    if (!t || !planes || !planesShown) return;
    const objects: (LineLoop | Mesh)[] = [];
    for (const { normal, color } of planes.cuts) {
      const corners = planeOutline(normal, planes.at, scene.shapeZyx, scene.spacingZyx);
      if (!corners.length) continue;
      // mm (z, y, x) to the scene's (x, y, z).
      const points = corners.map(([z, y, x]) => new Vector3(x, y, z));
      const edge = new LineLoop(
        new BufferGeometry().setFromPoints(points),
        new LineBasicMaterial({ color, transparent: true, opacity: 0.9 }),
      );
      const fill = new BufferGeometry().setFromPoints(points);
      fill.setIndex(points.slice(2).flatMap((_, i) => [0, i + 1, i + 2]));
      const face = new Mesh(
        fill,
        new MeshBasicMaterial({
          color,
          transparent: true,
          opacity: 0.08,
          side: DoubleSide,
          depthWrite: false,
        }),
      );
      objects.push(edge, face);
    }
    if (objects.length) t.planes.add(...objects);
    t.render();
    return () => {
      for (const object of objects) {
        t.planes.remove(object);
        object.geometry.dispose();
        (object.material as LineBasicMaterial).dispose();
      }
      t.render();
    };
  }, [planesKey, planesShown, scene.shapeZyx, scene.spacingZyx]);

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
    let ownLoaded = false;
    let ownLeft = false;
    for (const m of scene.meshes) {
      const mesh = t.meshes.getObjectByName(m.id);
      if (mesh instanceof Mesh) paint(mesh, m);
      if (m.own && mesh) ownLoaded = true;
      else if (m.own) ownLeft = true;
    }
    // Another output on this grid can name meshes already loaded as its own.
    if (ownLoaded && !ownLeft) t.aim();
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
    // Aim once every own mesh has loaded or failed.
    let ownLeft = missing.filter((m) => m.own).length;
    const settle = (m: GridMesh, error?: string) => {
      if (abort.signal.aborted) return;
      setMeshLoad((had) => ({ left: had.left - 1, error: had.error ?? error }));
      if (m.own && !--ownLeft) t.aim();
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
          // Vertices are voxel (x, y, z), in crop voxels for a cropped mask: to mm, the crop
          // offset, then for another grid's mesh its rigid placement onto this grid's voxels.
          const [oz, oy, ox] = m.offsetZyx;
          const matrix = new Matrix4().makeScale(sx, sy, sz);
          if (m.placement) matrix.multiply(new Matrix4().fromArray(m.placement.flat()).transpose());
          mesh.matrix.copy(matrix.multiply(new Matrix4().makeTranslation(ox, oy, oz)));
          mesh.matrixAutoUpdate = false;
          // So its world matrix is current before the first render, for the opening view's box.
          mesh.matrixWorldNeedsUpdate = true;
          paint(mesh, latestMeshes.current.find((l) => l.id === m.id) ?? m);
          t.meshes.add(mesh);
          t.render();
          settle(m);
        })
        .catch((cause) =>
          settle(m, `Couldn't load the ${m.name} mesh: ${(cause as Error).message}`),
        );
    return () => abort.abort();
  }, [meshIds]);

  // The volume: the coarsest level at once, then the finest that fits (`volumeLevel`); the raw
  // values are kept so a contrast change only rebuilds the bytes. Keyed by the asset, not the
  // object: Review rebuilds the scene on every display change. Not loaded at all under meshes.
  const [levels, setLevels] = useState<{ k: number; values: ArrayLike<number> }[]>([]);
  useEffect(() => {
    if (!volumeWanted) {
      setLevels([]);
      setVolumeLoad({ loading: false });
      return;
    }
    const abort = new AbortController();
    const { base, levels: all } = scene.image;
    const coarsest = all.length - 1;
    const target = volumeLevel(all);
    setVolumeLoad({ loading: true });
    const held: { release(): void }[] = [];
    (async () => {
      for (const k of target === coarsest ? [coarsest] : [coarsest, target]) {
        const level = holdLevel(base, all[k]!.path);
        held.push(level);
        const { data } = await level.read;
        if (abort.signal.aborted) return;
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
    return () => {
      abort.abort();
      for (const level of held) level.release();
    };
  }, [scene.image.base, volumeWanted]);
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
    (volumeWanted && !shown && !volumeLoad.error) || meshLoad.left > 0
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
    // biome-ignore lint/a11y/useSemanticElements: an interactive image surface, not a form fieldset.
    <div
      ref={host}
      className={PANE}
      role="group"
      aria-label="3D view"
      // biome-ignore lint/a11y/noNoninteractiveTabindex: the focused pane handles drawing cancellation.
      tabIndex={0}
      onPointerDown={() => host.current?.focus({ preventScroll: true })}
    >
      <div className="absolute top-2 right-2 z-20 flex items-center gap-1">
        {chip && (
          <span className={cx(CHIP, "static")} role="status">
            {chip}
          </span>
        )}
        {planes && (
          <Button
            size="sm"
            variant="ghost"
            aria-pressed={planesShown}
            title="Show where the three slices cut the knee"
            className="bg-viewer-chip text-viewer-chip-fg hover:bg-viewer-well hover:text-viewer-chip-fg aria-pressed:bg-viewer-chip aria-pressed:text-viewer-chip-fg"
            onClick={() => setPlanesShown((shown) => !shown)}
          >
            {planesShown ? "Hide planes" : "Show planes"}
          </Button>
        )}
        <IconButton
          size="sm"
          label="Reset the 3D view"
          className="bg-viewer-chip text-viewer-chip-fg hover:bg-viewer-well hover:text-viewer-chip-fg"
          onClick={() => three.current?.reset()}
        >
          <RotateCcw />
        </IconButton>
      </div>
    </div>
  );
}

function paint(mesh: Mesh, m: GridMesh) {
  const material = mesh.material as MeshStandardMaterial;
  material.color.set(m.color);
  material.opacity = m.opacity;
  material.transparent = m.opacity < 1;
  material.depthWrite = m.opacity >= 1;
  // A see-through shell shows its outer faces only: its back and inner faces would stack and
  // hide what it contains.
  material.side = m.opacity < 1 ? FrontSide : DoubleSide;
  material.needsUpdate = true;
  mesh.visible = m.opacity > 0;
  // Draw see-through shells after what they contain.
  mesh.renderOrder = m.opacity < 1 ? 1 : 0;
  // Which meshes the opening view faces (`opening` in the pane).
  mesh.userData.own = m.own;
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
