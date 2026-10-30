/**
 * The grid viewer's 3D pane: the image as a volume rendering with the scene's meshes in it, in
 * the grid's own mm (voxel × spacing; the grid's rotation into the scan is not applied). Drag
 * rotates, right drag pans, the wheel zooms; a click on a mesh moves the crosshair there. Loading
 * the volume or meshes never moves the camera.
 *
 * Each frame renders the meshes into a target with depth, copies it to the canvas, then
 * ray-marches the volume over it, stopping each ray at the meshes' depth (`volume.ts`).
 */
import { useEffect, useRef, useState } from "react";
import {
  AmbientLight,
  BufferAttribute,
  BufferGeometry,
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
  Raycaster,
  Scene,
  Vector2,
  Vector3,
  WebGLRenderer,
  WebGLRenderTarget,
} from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import type { Contrast } from "./compose";
import { readLevel } from "./planes";
import { capturePane, type GridMesh, type GridScene, type PaneHandle, type Zyx } from "./scene";
import { volumeBytes, volumeLevel, volumeMesh } from "./volume";

export function Grid3D({
  scene,
  contrast,
  onPoint,
  handle,
  onLoading,
}: {
  scene: GridScene;
  contrast: Contrast | null;
  onPoint(point: Zyx): void;
  /** Set while the pane is mounted, for screenshots. */
  handle: { current: PaneHandle | null };
  /** Whether the volume or a mesh is still loading or failed. */
  onLoading(loading: boolean): void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const three = useRef<{
    meshes: Group;
    volumes: Scene;
    depth: DepthTexture;
    render(): void;
  } | null>(null);
  const [status, setStatus] = useState<string>();
  const [volumeStatus, setVolumeStatus] = useState<string>();
  const latest = useRef(onPoint);
  latest.current = onPoint;
  const [sz, sy, sx] = scene.spacingZyx;
  const toWorld = (p: Zyx) => new Vector3(p[2] * sx, p[1] * sy, p[0] * sz);

  useEffect(() => {
    const element = host.current!;
    const renderer = new WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(globalThis.devicePixelRatio);
    const style = getComputedStyle(document.documentElement);
    renderer.setClearColor(style.getPropertyValue("--viewer-well").trim());
    renderer.domElement.className = "grid-canvas";
    element.append(renderer.domElement);
    const s = new Scene();
    const camera = new PerspectiveCamera(30, 1, 0.01, 1000);
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
      renderer.autoClear = true;
    };
    const render = () => {
      frame ||= requestAnimationFrame(draw);
    };
    controls.addEventListener("change", render);
    controls.update();
    three.current = { meshes, volumes, depth, render };
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
    // opaque mesh, so a structure inside a see-through bone shell wins over the shell.
    let downAt: [number, number] | null = null;
    const down = (event: PointerEvent) => {
      downAt = event.button === 0 ? [event.clientX, event.clientY] : null;
    };
    const up = (event: PointerEvent) => {
      if (!downAt || Math.hypot(event.clientX - downAt[0], event.clientY - downAt[1]) > 3) return;
      downAt = null;
      const rect = element.getBoundingClientRect();
      const ray = new Raycaster();
      ray.setFromCamera(
        new Vector2(
          ((event.clientX - rect.left) / rect.width) * 2 - 1,
          -((event.clientY - rect.top) / rect.height) * 2 + 1,
        ),
        camera,
      );
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
    return () => {
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
      three.current = null;
      handle.current = null;
    };
  }, []);

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
    if (missing.length)
      setStatus(`Loading ${missing.length} mesh${missing.length > 1 ? "es" : ""}…`);
    let left = missing.length;
    for (const m of missing)
      loadMesh(m, abort.signal)
        .then((geometry) => {
          const material = new MeshStandardMaterial({
            roughness: 0.75,
            metalness: 0,
            side: DoubleSide,
          });
          const mesh = new Mesh(geometry, material);
          mesh.name = m.id;
          // Vertices are voxel (x, y, z), in crop voxels for a cropped mask.
          mesh.scale.set(sx, sy, sz);
          mesh.position.copy(toWorld(m.offsetZyx));
          paint(mesh, latestMeshes.current.find((l) => l.id === m.id) ?? m);
          t.meshes.add(mesh);
          t.render();
        })
        .catch((cause) => {
          if (!abort.signal.aborted)
            setStatus(`Couldn't load the ${m.name} mesh: ${(cause as Error).message}`);
          left = -1;
        })
        .finally(() => {
          if (--left === 0) setStatus(undefined);
        });
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
    setVolumeStatus("Loading the volume…");
    (async () => {
      for (const k of target === coarsest ? [coarsest] : [coarsest, target]) {
        const { data } = await readLevel(base, all[k]!.path, abort.signal);
        setLevels((had) => [...had.filter((l) => l.k !== k), { k, values: data }]);
      }
      setVolumeStatus(undefined);
    })().catch((cause) => {
      if (!abort.signal.aborted)
        setVolumeStatus(`Couldn't load the volume: ${(cause as Error).message}`);
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
    const volume = volumeMesh(
      volumeBytes(shown.values, contrast),
      scene.image.levels[shown.k]!,
      scene.spacingZyx,
      getComputedStyle(document.documentElement).getPropertyValue("--bone").trim(),
      t.depth,
    );
    t.volumes.add(volume);
    t.render();
    return () => {
      t.volumes.remove(volume);
      volume.geometry.dispose();
      volume.material.uniforms.volume!.value.dispose();
      volume.material.dispose();
      t.render();
    };
  }, [shown, contrast]);

  const chip = volumeStatus ?? status;
  const latestLoading = useRef(onLoading);
  latestLoading.current = onLoading;
  const loading = !!chip || !shown;
  useEffect(() => latestLoading.current(loading), [loading]);
  return (
    <div ref={host} className="grid-pane">
      {chip && (
        <span className="grid-chip top-right" role="status">
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

async function loadMesh(m: GridMesh, signal: AbortSignal) {
  const response = await fetch(m.url, { signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength !== m.vertices * 12 + m.indices * 4)
    throw new Error("the file has the wrong size");
  const geometry = new BufferGeometry();
  geometry.setAttribute(
    "position",
    new BufferAttribute(new Float32Array(bytes, 0, m.vertices * 3), 3),
  );
  geometry.setIndex(new BufferAttribute(new Uint32Array(bytes, m.vertices * 12, m.indices), 1));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}
