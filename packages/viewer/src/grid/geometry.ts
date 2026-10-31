/** Published mesh geometry and its intersection with a source-voxel slice plane. */
import { BufferAttribute, BufferGeometry } from "three";
import type { Axis, GridMesh, Zyx } from "./scene";

export async function loadMesh(m: GridMesh, signal: AbortSignal) {
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

/** Segments in source voxels, including boundary edges of coplanar surface patches. */
export function surfaceTrace(geometry: BufferGeometry, axis: Axis, at: number, offset: Zyx): Zyx[] {
  const positions = geometry.getAttribute("position");
  const indices = geometry.getIndex()!;
  const segments: Zyx[] = [];
  const onPlane = new Map<string, { a: Zyx; b: Zyx; coplanarFaces: number }>();
  const vertex = (i: number): Zyx => {
    const j = indices.getX(i);
    return [
      positions.getZ(j) + offset[0],
      positions.getY(j) + offset[1],
      positions.getX(j) + offset[2],
    ];
  };
  for (let i = 0; i < indices.count; i += 3) {
    const triangle = [vertex(i), vertex(i + 1), vertex(i + 2)];
    const coplanar = triangle.every((p) => p[axis] === at);
    let hasEdge = false;
    for (let e = 0; e < 3; e++) {
      const next = (e + 1) % 3;
      const a = triangle[e]!;
      const b = triangle[next]!;
      if (a[axis] !== at || b[axis] !== at) continue;
      hasEdge = true;
      const j = indices.getX(i + e);
      const k = indices.getX(i + next);
      const key = `${Math.min(j, k)}/${Math.max(j, k)}`;
      const edge = onPlane.get(key) ?? { a, b, coplanarFaces: 0 };
      if (coplanar) edge.coplanarFaces++;
      onPlane.set(key, edge);
    }
    if (hasEdge) continue;
    const hits: Zyx[] = [];
    for (let e = 0; e < 3; e++) {
      const a = triangle[e]!;
      const b = triangle[(e + 1) % 3]!;
      if ((a[axis] <= at && b[axis] > at) || (b[axis] <= at && a[axis] > at)) {
        const t = (at - a[axis]) / (b[axis] - a[axis]);
        hits.push(a.map((v, k) => v + t * (b[k]! - v)) as unknown as Zyx);
      }
    }
    if (hits.length === 2) segments.push(...hits);
  }
  for (const { a, b, coplanarFaces } of onPlane.values())
    if (coplanarFaces < 2) segments.push(a, b);
  return segments;
}

/** A ruler's part inside a one-source-voxel slice slab, never a projection from another slice. */
export function sliceSegment(a: Zyx, b: Zyx, axis: Axis, at: number): [Zyx, Zyx] | null {
  const delta = b[axis] - a[axis];
  if (!delta) return Math.abs(a[axis] - at) <= 0.5 ? [a, b] : null;
  const t0 = (at - 0.5 - a[axis]) / delta;
  const t1 = (at + 0.5 - a[axis]) / delta;
  const lo = Math.max(0, Math.min(t0, t1));
  const hi = Math.min(1, Math.max(t0, t1));
  if (lo > hi) return null;
  const along = (t: number) => a.map((v, k) => v + t * (b[k]! - v)) as unknown as Zyx;
  return [along(lo), along(hi)];
}
