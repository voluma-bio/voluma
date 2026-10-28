/** Geometry and bounded trilinear resampling for display, never segmentation or measurement. */
import type { DicomSeries, Point3 } from "./dicom";
import type { DicomSession } from "./dicomSession";

export function planVolume(series: DicomSeries, limit: 128 | 256) {
  const source: Point3 = [series.columns, series.rows, series.slices.length];
  const first = series.slices[0];
  const last = series.slices.at(-1);
  if (!first || !last || source.some((n) => n < 2))
    throw new Error(
      "3D needs at least two slices and two pixels on each axis. Acquired slices remain available.",
    );
  if (series.slices.some((slice) => slice.frameOfReferenceUID !== first.frameOfReferenceUID))
    throw new Error(
      "3D needs matching frame-of-reference identifiers, or none on every slice. Acquired slices remain available.",
    );
  const o = series.orientation;
  const normal: Point3 = [
    o[1] * o[5] - o[2] * o[4],
    o[2] * o[3] - o[0] * o[5],
    o[0] * o[4] - o[1] * o[3],
  ];
  const length = Math.hypot(...normal);
  for (const axis of [0, 1, 2] as const) normal[axis] /= length;
  const axes = [0, 1, 2] as const;
  const origin = first.position;
  const dz =
    axes.reduce<number>(
      (sum, axis) => sum + normal[axis] * (last.position[axis] - origin[axis]),
      0,
    ) /
    (source[2] - 1);
  // Reject missing slices, nonuniform gaps and in-plane drift/gantry tilt. The
  // tolerance is 1% of a slice interval, with a 0.001 mm rounding allowance.
  const tolerance = Math.max(0.001, dz * 0.01);
  if (
    !(dz > 0) ||
    series.slices.some(
      ({ position }, index) =>
        Math.hypot(
          ...axes.map((axis) => position[axis] - origin[axis] - normal[axis] * dz * index),
        ) > tolerance,
    )
  )
    throw new Error(
      "3D requires regular spacing without missing slices or in-plane drift. This series can still be viewed as acquired slices.",
    );
  const factor = Math.max(1, ...source.map((n) => (n - 1) / (limit - 1)));
  const dimensions = source.map((n) => Math.max(2, Math.floor((n - 1) / factor) + 1)) as Point3;
  const steps = axes.map((axis) => (source[axis] - 1) / (dimensions[axis] - 1)) as Point3;
  const spacing: Point3 = [
    (series.spacing[1] as number) * steps[0],
    (series.spacing[0] as number) * steps[1],
    dz * steps[2],
  ];
  return {
    source,
    dimensions,
    steps,
    spacing,
    origin,
    direction: [...o, ...normal] as [
      number,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
    ],
    bytes: dimensions[0] * dimensions[1] * dimensions[2] * 4,
    downsampled: factor > 1,
  };
}

export type VolumePlan = ReturnType<typeof planVolume>;

export async function sampleVolume(
  session: DicomSession,
  plan: VolumePlan,
  signal: AbortSignal,
  progress: (done: number) => void,
) {
  signal.throwIfAborted();
  const {
    source,
    dimensions: [width, height, depth],
    steps,
  } = plan;
  const scalarData = new Float32Array(width * height * depth);
  let min = Infinity;
  let max = -Infinity;
  const contributions = Array.from(
    { length: source[2] },
    () => [] as { z: number; weight: number; last: boolean }[],
  );
  for (let z = 0; z < depth; z++) {
    const sourceZ = Math.min(source[2] - 1, z * steps[2]);
    const low = Math.floor(sourceZ);
    const fraction = sourceZ - low;
    contributions[low]?.push({ z, weight: 1 - fraction, last: fraction === 0 });
    if (fraction) contributions[low + 1]?.push({ z, weight: fraction, last: true });
  }
  // A source plane can feed adjacent output planes. Consume it once before
  // the session evicts it; skip source planes with no interpolation weight.
  for (const [slice, planes] of contributions.entries()) {
    signal.throwIfAborted();
    if (!planes.length) continue;
    await session.read(slice, async (image) => {
      signal.throwIfAborted();
      if (image.modalityLUT) throw new Error("Nonlinear modality LUT is not supported for 3D");
      const pixels = image.getPixelData();
      const slope = image.preScale?.scaled ? 1 : image.slope;
      const intercept = image.preScale?.scaled ? 0 : image.intercept;
      if (!Number.isFinite(slope) || !Number.isFinite(intercept))
        throw new Error("Invalid intensity transform");
      for (const { z, weight, last } of planes) {
        signal.throwIfAborted();
        for (let y = 0; y < height; y++) {
          const sy = Math.min(source[1] - 1, y * steps[1]);
          const y0 = Math.floor(sy),
            y1 = Math.min(y0 + 1, source[1] - 1),
            fy = sy - y0;
          for (let x = 0; x < width; x++) {
            const sx = Math.min(source[0] - 1, x * steps[0]);
            const x0 = Math.floor(sx),
              x1 = Math.min(x0 + 1, source[0] - 1),
              fx = sx - x0;
            const a =
              (pixels[y0 * source[0] + x0] as number) * (1 - fx) +
              (pixels[y0 * source[0] + x1] as number) * fx;
            const b =
              (pixels[y1 * source[0] + x0] as number) * (1 - fx) +
              (pixels[y1 * source[0] + x1] as number) * fx;
            const offset = (z * height + y) * width + x;
            scalarData[offset] =
              (scalarData[offset] as number) +
              ((a * (1 - fy) + b * fy) * slope + intercept) * weight;
          }
        }
        if (!last) continue;
        for (let i = z * width * height; i < (z + 1) * width * height; i++) {
          const value = scalarData[i] as number;
          if (!Number.isFinite(value)) throw new Error("Invalid decoded intensity");
          min = Math.min(min, value);
          max = Math.max(max, value);
        }
        progress(z + 1);
        // Allow cancel, slice navigation and progress to paint between planes.
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    });
  }
  return { scalarData, min, max: Math.max(max, min + 1) };
}
