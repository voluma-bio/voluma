/**
 * Where the outputs review's slice panes lie. Each pane has a basis in the grid's mm, (z, y, x)
 * order: `right` and `down` on screen, `normal` out of the plane. Untilted, the three panes hold
 * the grid's axes (`GRID`); tilting by hand turns two of them about the third's normal, and
 * aligning turns all three onto a target (a fitted plane, or another grid's axes). Their normals
 * stay perpendicular to each other throughout.
 */
import { type Axis, planeAxes, type Zyx } from "./scene";

export type Vec3 = readonly [number, number, number];
export type Basis = { right: Vec3; down: Vec3; normal: Vec3 };
/** The bases of the panes that hold z, y and x when untilted: XY, XZ, YZ. */
export type Orientation = readonly [Basis, Basis, Basis];

const E: readonly Vec3[] = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];

export const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const plus = (a: Vec3, b: Vec3, k = 1): Vec3 => [a[0] + k * b[0], a[1] + k * b[1], a[2] + k * b[2]];
const times = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
export const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const unit = (a: Vec3): Vec3 => times(a, 1 / (Math.hypot(...a) || 1));
/** `a` without its part along each of `against` (unit vectors), made unit. */
const orthogonal = (a: Vec3, ...against: Vec3[]) =>
  unit(against.reduce((v, b) => plus(v, b, -dot(v, b)), a));

/** The pane holding `axis` on the grid's own axes. */
export function gridBasis(axis: Axis): Basis {
  const [ra, ca] = planeAxes(axis);
  return { right: E[ca]!, down: E[ra]!, normal: E[axis]! };
}
export const GRID: Orientation = [gridBasis(0), gridBasis(1), gridBasis(2)];

const same = (a: Vec3, b: Vec3) =>
  Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) < 1e-9;
/** Whether the pane lies on the grid's axes, so it reads whole slices of the grid. */
export const onGrid = (b: Basis, axis: Axis) => {
  const g = GRID[axis];
  return same(b.normal, g.normal) && same(b.right, g.right) && same(b.down, g.down);
};

/** `v` turned by `angle` (radians) about the unit vector `k` (Rodrigues). */
function turn(v: Vec3, k: Vec3, angle: number): Vec3 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return plus(plus(times(v, c), cross(k, v), s), k, dot(k, v) * (1 - c));
}
const turnBasis = (b: Basis, k: Vec3, angle: number): Basis => ({
  right: turn(b.right, k, angle),
  down: turn(b.down, k, angle),
  normal: turn(b.normal, k, angle),
});

/** The angle about `n` that turns the in-plane direction `from` onto `to`, the sign as `turn`'s. */
export const angleAbout = (from: Vec3, to: Vec3, n: Vec3) =>
  Math.atan2(dot(cross(from, to), n), dot(from, to));

/** The other two panes turned by `angle` about pane `about`'s normal; that pane stays still. */
export function tilt(o: Orientation, about: Axis, angle: number): Orientation {
  const k = o[about].normal;
  return o.map((b, a) => (a === about ? b : turnBasis(b, k, angle))) as unknown as Orientation;
}

/** How far the panes are from the grid's axes, in degrees: the largest angle between a pane and its grid plane. */
export function offGrid(o: Orientation): number {
  const worst = Math.min(...o.map((b, a) => Math.abs(dot(b.normal, E[a]!))));
  return (Math.acos(Math.min(1, worst)) * 180) / Math.PI;
}

/** Below this the panes count as on the grid's axes. */
const UNTILTED_DEGREES = 0.05;
const degrees = (d: number) => `${d < 10 ? d.toFixed(1) : Math.round(d)}°`;

/**
 * How the panes lie, in words ("Tilted 18°", "Along the growth plate, 12° off the grid"), aligned
 * to the target named `aligned`; undefined on the grid's axes.
 */
export function orientationWords(o: Orientation, aligned: string | undefined): string | undefined {
  const off = offGrid(o);
  if (off < UNTILTED_DEGREES) return undefined;
  return aligned ? `Along ${aligned}, ${degrees(off)} off the grid` : `Tilted ${degrees(off)}`;
}

/**
 * Panes whose normals are `normals` (perpendicular unit vectors, by the axis each replaces):
 * each pane's rows and columns follow the other two normals, as on the grid.
 */
function frameOf(normals: readonly Vec3[]): Orientation {
  return ([0, 1, 2] as const).map((a) => {
    const [ra, ca] = planeAxes(a);
    return { right: normals[ca]!, down: normals[ra]!, normal: normals[a]! };
  }) as unknown as Orientation;
}

/** The axis whose plane lies closest to a plane with normal `n`. */
export const nearestAxis = (n: Vec3): Axis =>
  ([0, 1, 2] as const).reduce((best, a) => (Math.abs(n[a]) > Math.abs(n[best]) ? a : best), 0);

/**
 * The panes turned the least to put one of them along the plane with normal `n`: the pane
 * nearest that plane takes it, the others follow by Gram–Schmidt from the grid's axes.
 */
export function alongPlane(n: Vec3): Orientation {
  const k = nearestAxis(n);
  const normals: Vec3[] = [];
  normals[k] = unit(n[k] < 0 ? times(n, -1) : n);
  const done = [normals[k]!];
  for (const a of [0, 1, 2] as const) {
    if (a === k) continue;
    normals[a] = orthogonal(E[a]!, ...done);
    done.push(normals[a]!);
  }
  // The panes must stay a rotation of the grid's: never a mirror.
  if (dot(cross(normals[0]!, normals[1]!), normals[2]!) < 0) {
    const last = ([0, 1, 2] as const).filter((a) => a !== k).at(-1)!;
    normals[last] = times(normals[last]!, -1);
  }
  return frameOf(normals);
}

/**
 * Panes along another grid's axes (`axes`: its z, y and x directions in this grid's mm), each
 * flipped to face the same way as this grid's, so a pane never shows mirrored.
 */
export function alongAxes(axes: readonly [Vec3, Vec3, Vec3]): Orientation {
  // Pair each of this grid's axes with the other grid's axis nearest it.
  const order: Axis[] = [];
  for (const a of [0, 1, 2] as const) {
    const free = ([0, 1, 2] as const).filter((b) => !order.includes(b));
    order.push(
      free.reduce((best, b) => (Math.abs(axes[b][a]) > Math.abs(axes[best][a]) ? b : best)),
    );
  }
  const normals = order.map((b, a) => unit(axes[b][a as Axis] < 0 ? times(axes[b], -1) : axes[b]));
  return frameOf(fixHanded(normals));
}

/** A mirrored triple made a rotation by flipping its last vector. */
function fixHanded(normals: Vec3[]): Vec3[] {
  const [n0, n1, n2] = normals as [Vec3, Vec3, Vec3];
  return dot(cross(n0, n1), n2) < 0 ? [n0, n1, times(n2, -1)] : normals;
}

/** A single pane along the plane with normal `n`, laid out as the grid pane nearest it. */
export function basisAlong(n: Vec3): Basis {
  return alongPlane(n)[nearestAxis(n)];
}

/**
 * The normal of the plane fitted (least squares) through `points` (flat x, y, z triples, any
 * number of arrays), in whatever space they are given: the eigenvector of their scatter with the
 * smallest eigenvalue, by Jacobi rotations.
 */
export function fitNormal(points: readonly ArrayLike<number>[]): Vec3 | null {
  let n = 0;
  const mean = [0, 0, 0];
  for (const p of points)
    for (let i = 0; i + 2 < p.length; i += 3) {
      if (!Number.isFinite(p[i]! + p[i + 1]! + p[i + 2]!)) continue;
      n++;
      for (let k = 0; k < 3; k++) mean[k]! += p[i + k]!;
    }
  if (n < 3) return null;
  for (let k = 0; k < 3; k++) mean[k]! /= n;
  const m = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (const p of points)
    for (let i = 0; i + 2 < p.length; i += 3) {
      if (!Number.isFinite(p[i]! + p[i + 1]! + p[i + 2]!)) continue;
      for (let r = 0; r < 3; r++)
        for (let c = r; c < 3; c++) m[r]![c]! += (p[i + r]! - mean[r]!) * (p[i + c]! - mean[c]!);
    }
  for (let r = 0; r < 3; r++) for (let c = 0; c < r; c++) m[r]![c] = m[c]![r]!;
  // v's columns are the eigenvectors once m is diagonal.
  const v = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  for (let sweep = 0; sweep < 50; sweep++) {
    const off = Math.abs(m[0]![1]!) + Math.abs(m[0]![2]!) + Math.abs(m[1]![2]!);
    if (off < 1e-12 * (Math.abs(m[0]![0]!) + Math.abs(m[1]![1]!) + Math.abs(m[2]![2]!) + 1e-30))
      break;
    for (const [p, q] of [
      [0, 1],
      [0, 2],
      [1, 2],
    ] as const) {
      if (Math.abs(m[p]![q]!) < 1e-300) continue;
      const theta = (m[q]![q]! - m[p]![p]!) / (2 * m[p]![q]!);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1);
      const s = t * c;
      for (let k = 0; k < 3; k++) {
        const mkp = m[k]![p]!;
        const mkq = m[k]![q]!;
        m[k]![p] = c * mkp - s * mkq;
        m[k]![q] = s * mkp + c * mkq;
      }
      for (let k = 0; k < 3; k++) {
        const mpk = m[p]![k]!;
        const mqk = m[q]![k]!;
        m[p]![k] = c * mpk - s * mqk;
        m[q]![k] = s * mpk + c * mqk;
      }
      for (let k = 0; k < 3; k++) {
        const vkp = v[k]![p]!;
        const vkq = v[k]![q]!;
        v[k]![p] = c * vkp - s * vkq;
        v[k]![q] = s * vkp + c * vkq;
      }
    }
  }
  const least = ([0, 1, 2] as const).reduce((best, k) => (m[k]![k]! < m[best]![best]! ? k : best));
  return unit([v[0]![least]!, v[1]![least]!, v[2]![least]!]);
}

/**
 * The signed distance of a source position from a pane's plane through `at`, in slices: within
 * ½ is on the slice. An untilted pane's slice is one source voxel thick and sits on a whole
 * voxel; a tilted one is the grid's finest spacing thick.
 */
export type Slab = (p: Zyx) => number;
export function slabOf(basis: Basis, axis: Axis | null, at: Zyx, spacingZyx: Zyx): Slab {
  if (axis !== null && onGrid(basis, axis)) {
    const index = Math.round(at[axis]);
    return (p) => p[axis] - index;
  }
  const n = basis.normal;
  const h = Math.min(...spacingZyx);
  const [sz, sy, sx] = spacingZyx;
  const d = (at[0] * sz * n[0] + at[1] * sy * n[1] + at[2] * sx * n[2]) / h;
  return (p) => (p[0] * sz * n[0] + p[1] * sy * n[1] + p[2] * sx * n[2]) / h - d;
}
