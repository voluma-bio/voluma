/**
 * The grid viewer's 3D pane: the scene's meshes and the three slice pictures at the crosshair,
 * in the grid's own mm (voxel × spacing; the grid's rotation into the scan is not applied).
 * Drag rotates, right drag pans, the wheel zooms; a click on a mesh moves the crosshair there.
 * New pictures or meshes never move the camera.
 */
import { useEffect, useRef, useState } from "react";
import {
  AmbientLight,
  BufferAttribute,
  BufferGeometry,
  DirectionalLight,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PerspectiveCamera,
  Raycaster,
  Scene,
  Vector2,
  Vector3,
  WebGLRenderer,
} from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { corners, type Picture, quad, texture } from "./picture";
import type { Axis, GridMesh, GridScene, Zyx } from "./scene";

export function Grid3D({
  scene,
  pictures,
  onPoint,
}: {
  scene: GridScene;
  pictures: Partial<Record<Axis, Picture>>;
  onPoint(point: Zyx): void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const three = useRef<{
    planes: Mesh<BufferGeometry, MeshBasicMaterial>[];
    meshes: Group;
    render(): void;
  } | null>(null);
  const [status, setStatus] = useState<string>();
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
    const planes = ([0, 1, 2] as const).map(() => {
      const plane = new Mesh(
        new BufferGeometry(),
        new MeshBasicMaterial({ side: DoubleSide, transparent: true, opacity: 0.9 }),
      );
      plane.visible = false;
      s.add(plane);
      return plane;
    });
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.copy(center);
    controls.enableDamping = false;
    // One frame per animation frame, however many changes asked for it.
    let frame = 0;
    const render = () => {
      frame ||= requestAnimationFrame(() => {
        frame = 0;
        renderer.render(s, camera);
      });
    };
    controls.addEventListener("change", render);
    controls.update();
    three.current = { planes, meshes, render };
    const observer = new ResizeObserver(() => {
      const { width, height } = element.getBoundingClientRect();
      if (!width || !height) return;
      renderer.setSize(width, height);
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
      s.traverse((object) => {
        if (object instanceof Mesh) {
          object.geometry.dispose();
          object.material.map?.dispose();
          object.material.dispose();
        }
      });
      renderer.forceContextLoss();
      renderer.dispose();
      renderer.domElement.remove();
      three.current = null;
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

  useEffect(() => {
    const t = three.current;
    if (!t) return;
    for (const axis of [0, 1, 2] as const) {
      const picture = pictures[axis];
      const plane = t.planes[axis]!;
      // Only the plane whose picture changed uploads a texture; a cleared picture hides it.
      if (plane.userData.picture === picture) continue;
      plane.userData.picture = picture;
      if (!picture) {
        plane.visible = false;
        continue;
      }
      plane.geometry.dispose();
      plane.geometry = quad(corners(picture).map((p) => toWorld(p).toArray()));
      plane.material.map?.dispose();
      plane.material.map = texture(picture, false);
      plane.material.needsUpdate = true;
      plane.visible = true;
    }
    t.render();
  }, [pictures]);

  return (
    <div ref={host} className="grid-pane">
      {status && (
        <span className="grid-chip top-right" role="status">
          {status}
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
