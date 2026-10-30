/** Scan-aligned label data and display targets. No resampling or scientific edits. */
import type { Annotation, Focus, Structure, Volume } from "@voluma/contracts/review";
import type { DicomSeries, Point3 } from "./dicom";
import { planVolume } from "./volume";

export type LabelSource = { volume: Volume; url: string };
export type LabelVolume = LabelSource & {
  values: Uint8Array | Uint16Array;
  bounds: Record<number, { min: Point3; max: Point3; point: Point3 }>;
};
export type StructureDisplay = Record<string, { visible: boolean; opacity: number }>;

export function scanWorld(series: DicomSeries, zyx: readonly number[]): Point3 {
  const z = Math.max(0, Math.min(series.slices.length - 1, zyx[0]!));
  const origin = series.slices[Math.round(z)]!.position;
  return origin.map(
    (n, a) =>
      n +
      series.orientation[a]! * zyx[2]! * series.spacing[1]! +
      series.orientation[a + 3]! * zyx[1]! * series.spacing[0]!,
  ) as Point3;
}

/** Refuse an overlay on another acquisition, reversed grid or irregular series. */
export function assertLabelGrid(volume: Volume, series: DicomSeries) {
  const plan = planVolume(series);
  if (volume.shapeZyx.some((n, i) => n !== plan.dimensions[2 - i]))
    throw new Error(`${volume.name}: label dimensions do not match this scan.`);
  // Coefficient tolerances accumulate across large grids. Check each slice's
  // corners in world mm, including internal slice drift, within 1% of a voxel.
  const tolerance = Math.min(...plan.spacing) * 0.01;
  for (let z = 0; z < series.slices.length; z++)
    for (const y of [0, series.rows - 1])
      for (const x of [0, series.columns - 1]) {
        const actual = voxelWorld(volume, [z, y, x]);
        const expected = scanWorld(series, [z, y, x]);
        if (Math.hypot(...actual.map((n, i) => n - expected[i]!)) > tolerance)
          throw new Error(`${volume.name}: label geometry does not match this scan.`);
      }
}

export function focusTarget(
  focus: Focus | undefined,
  layers: LabelVolume[],
  structures: Structure[],
  annotations: Annotation[],
  series?: DicomSeries,
) {
  if (!focus) return;
  let box = focus.box;
  let point =
    focus.point ??
    (box?.min.map((n, i) => Math.round((n + box!.max[i]!) / 2)) as Point3 | undefined);
  if (!point && series) {
    const positions = annotations
      .filter((a) => focus.on.includes(a.id))
      .flatMap((a) => (a.kind === "point" ? [a.position] : [a.a, a.b]));
    const points = positions.map((world): Point3 => {
      let closest = 0;
      let distance = Infinity;
      series.slices.forEach((slice, i) => {
        const delta = world.map((n, a) => n - slice.position[a]!);
        const o = series.orientation;
        const normal = [
          o[1] * o[5] - o[2] * o[4],
          o[2] * o[3] - o[0] * o[5],
          o[0] * o[4] - o[1] * o[3],
        ];
        const d = Math.abs(delta.reduce((sum, n, a) => sum + n * normal[a]!, 0));
        if (d < distance) {
          distance = d;
          closest = i;
        }
      });
      const delta = world.map((n, a) => n - series.slices[closest]!.position[a]!);
      return [
        closest,
        Math.round(
          delta.reduce((sum, n, a) => sum + n * series.orientation[a + 3]!, 0) / series.spacing[0]!,
        ),
        Math.round(
          delta.reduce((sum, n, a) => sum + n * series.orientation[a]!, 0) / series.spacing[1]!,
        ),
      ];
    });
    point = points[0];
    if (!box && points.length > 1)
      box = {
        min: [0, 1, 2].map((a) => Math.min(...points.map((p) => p[a]!))) as Point3,
        max: [0, 1, 2].map((a) => Math.max(...points.map((p) => p[a]!))) as Point3,
      };
  }
  const refs = focus.volumeId
    ? [{ volumeId: focus.volumeId, label: focus.label }]
    : structures
        .filter((s) => focus.on.includes(s.id))
        .flatMap((s) =>
          s.volumeId !== null && s.voxels && "label" in s.voxels
            ? [{ volumeId: s.volumeId, label: s.voxels.label }]
            : [],
        );
  for (const ref of refs) {
    const layer = layers.find((l) => l.volume.id === ref.volumeId);
    if (!layer) continue;
    for (const [label, bounds] of Object.entries(layer.bounds)) {
      if (ref.label !== undefined && Number(label) !== ref.label) continue;
      if (!box) box = { min: [...bounds.min], max: [...bounds.max] };
      else if (!focus.box) {
        box = {
          min: box.min.map((n, i) => Math.min(n, bounds.min[i]!)) as Point3,
          max: box.max.map((n, i) => Math.max(n, bounds.max[i]!)) as Point3,
        };
      }
      point ??= bounds.point;
    }
  }
  point ??= box?.min.map((n, i) => Math.round((n + box!.max[i]!) / 2)) as Point3 | undefined;
  return { box, point };
}

export function voxelWorld(volume: Volume, zyx: readonly number[]): Point3 {
  const xyz = [zyx[2]!, zyx[1]!, zyx[0]!];
  return volume.affine
    .slice(0, 3)
    .map((row) => row[3]! + xyz.reduce((sum, n, i) => sum + n * row[i]!, 0)) as Point3;
}
