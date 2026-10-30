/**
 * The grid viewer's 3D pane: the scene's meshes and the three slice pictures at the crosshair,
 * in the grid's own mm (voxel × spacing; the grid's rotation into the scan is not applied).
 * Drag rotates, right drag pans, the wheel zooms; a click on a mesh moves the crosshair there.
 * New pictures or meshes never move the camera. Marks show as a dot or a box's edges in `--mark`.
 */
import { useEffect, useRef, useState } from "react";
import {
  AmbientLight,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  DirectionalLight,
  DoubleSide,
  EdgesGeometry,
  Group,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PerspectiveCamera,
  Raycaster,
  Scene,
  SphereGeometry,
  Vector2,
  Vector3,
  WebGLRenderer,
} from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { corners, type Picture, quad, texture } from "./picture";
import type { Capture } from "./SlicePane";
import type { Axis, GridMark, GridMesh, GridScene, Zyx } from "./scene";

export function Grid3D({
  scene,
  pictures,
  onPoint,
  marks,
  onCapture,
}: {
  scene: GridScene;
  pictures: Partial<Record<Axis, Picture>>;
  onPoint(point: Zyx): void;
  marks: readonly GridMark[];
  onCapture(capture: Capture | null): void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const three = useRef<{
    planes: Mesh<BufferGeometry, MeshBasicMaterial>[];
    meshes: Group;
    marks: Group;
    /** World mm across the grid's diagonal, half of it. */
    radius: number;
    render(): void;
  } | null>(null);
  const [status, setStatus] = useState<string>();
  const latest = useRef(onPoint);
  latest.current = onPoint;
  const [sz, sy, sx] = scene.spacingZyx;
  const toWorld = (p: Zyx) => new Vector3(p[2] * sx, p[1] * sy, p[0] * sz);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the grid is fixed for the pane's life.
  useEffect(() => {
    const element = host.current!;
    const renderer = new WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(globalThis.devicePixelRatio);
    const style = getComputedStyle(document.documentElement);
    renderer.setClearColor(style.getPropertyValue("--viewer-well"));
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
    const marks = new Group();
    s.add(meshes, marks);
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
    three.current = { planes, meshes, marks, radius, render };
    onCapture(() => {
      renderer.render(s, camera);
      return renderer.domElement;
    });
    const observer = new ResizeObserver(() => {
      const { width, height } = element.getBoundingClientRect();
      if (!width || !height) return;
      renderer.setSize(width, height);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      render();
    });
    observer.observe(element);

    // A click (not a drag) on a mesh moves the crosshair to the voxel under it.
    let downAt: [number, number] | null = null;
    const down = (event: PointerEvent) => {
      downAt = [event.clientX, event.clientY];
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
      const hit = ray.intersectObjects(meshes.children, true).find((h) => h.object.visible);
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
      onCapture(null);
      controls.dispose();
      s.traverse((object) => {
        if (object instanceof LineSegments) {
          object.geometry.dispose();
          object.material.dispose();
        }
        if (object instanceof Mesh) {
          object.geometry.dispose();
          object.material.map?.dispose();
          object.material.dispose();
        }
      });
      renderer.dispose();
      renderer.domElement.remove();
      three.current = null;
    };
  }, []);

  // Meshes load once each; a scene change adds or drops only what changed.
  // biome-ignore lint/correctness/useExhaustiveDependencies: toWorld depends only on the fixed grid.
  useEffect(() => {
    const t = three.current;
    if (!t) return;
    const abort = new AbortController();
    const wanted = new Map(scene.meshes.map((m) => [m.id, m]));
    for (const child of [...t.meshes.children]) {
      if (wanted.has(child.name)) continue;
      t.meshes.remove(child);
      if (child instanceof Mesh) {
        child.geometry.dispose();
        child.material.dispose();
      }
    }
    const missing = scene.meshes.filter((m) => !t.meshes.getObjectByName(m.id));
    if (missing.length)
      setStatus(`Loading ${missing.length} mesh${missing.length > 1 ? "es" : ""}…`);
    let left = missing.length;
    for (const m of missing)
      loadMesh(m, abort.signal)
        .then((geometry) => {
          const material = new MeshStandardMaterial({
            color: m.color,
            roughness: 0.75,
            metalness: 0,
            transparent: m.opacity < 1,
            opacity: m.opacity,
            depthWrite: m.opacity >= 1,
            side: DoubleSide,
          });
          const mesh = new Mesh(geometry, material);
          mesh.name = m.id;
          // Vertices are voxel (x, y, z), in crop voxels for a cropped mask.
          mesh.scale.set(sx, sy, sz);
          mesh.position.copy(toWorld(m.offsetZyx));
          // Draw see-through shells after what they contain.
          mesh.renderOrder = m.opacity < 1 ? 1 : 0;
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
  }, [scene.meshes]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: toWorld depends only on the fixed grid.
  useEffect(() => {
    const t = three.current;
    if (!t) return;
    for (const child of [...t.marks.children]) {
      t.marks.remove(child);
      if (child instanceof Mesh || child instanceof LineSegments) {
        child.geometry.dispose();
        child.material.dispose();
      }
    }
    const color = new Color(
      getComputedStyle(document.documentElement).getPropertyValue("--mark").trim(),
    );
    // Transparent, so they draw after the see-through slice planes and stay on top.
    for (const mark of marks) {
      if ("point" in mark) {
        const dot = new Mesh(
          new SphereGeometry(t.radius * 0.012, 16, 12),
          new MeshBasicMaterial({ color, depthTest: false, transparent: true }),
        );
        dot.position.copy(toWorld(mark.point));
        dot.renderOrder = 2;
        t.marks.add(dot);
      } else {
        const { min, max } = mark.box;
        // Voxel i spans i ± ½.
        const lo = toWorld([min[0] - 0.5, min[1] - 0.5, min[2] - 0.5]);
        const hi = toWorld([max[0] + 0.5, max[1] + 0.5, max[2] + 0.5]);
        const size = hi.clone().sub(lo);
        const box = new BoxGeometry(size.x, size.y, size.z);
        const edges = new LineSegments(
          new EdgesGeometry(box),
          new LineBasicMaterial({ color, depthTest: false, transparent: true }),
        );
        box.dispose();
        edges.position.copy(lo.add(hi).multiplyScalar(0.5));
        edges.renderOrder = 2;
        t.marks.add(edges);
      }
    }
    t.render();
  }, [marks]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: toWorld depends only on the fixed grid.
  useEffect(() => {
    const t = three.current;
    if (!t) return;
    for (const axis of [0, 1, 2] as const) {
      const picture = pictures[axis];
      const plane = t.planes[axis]!;
      // Only the plane whose picture changed uploads a texture.
      if (!picture || plane.userData.picture === picture) continue;
      plane.userData.picture = picture;
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
