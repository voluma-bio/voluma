/** Volume geometry and native-grid copy for display, never segmentation or measurement. */
import type { Types } from "@cornerstonejs/core";
import type { DicomSeries, Point3 } from "./dicom";
import type { DicomSession } from "./dicomSession";

export function planVolume(series: DicomSeries) {
  const dimensions: Point3 = [series.columns, series.rows, series.slices.length];
  const first = series.slices[0];
  const last = series.slices.at(-1);
  if (!first || !last || dimensions.some((n) => n < 2))
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
    (dimensions[2] - 1);
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
  // The native grid keeps stored integers when every slice shares one increasing
  // linear rescale: 1 or 2 bytes per voxel instead of 4, and display maps
  // intensities by range, so the affine offset is invisible. Otherwise voxels
  // are Float32 modality values.
  const { signed, slope, intercept } = first.stored;
  const stored =
    // The loader's PT (SUV) and RTDOSE (dose grid) prescale is not the rescale.
    !["PT", "RTDOSE"].includes(series.modality) &&
    Number.isFinite(slope) &&
    Number.isFinite(intercept) &&
    slope > 0 &&
    series.slices.every(
      (s) =>
        s.stored.signed === signed && s.stored.slope === slope && s.stored.intercept === intercept,
    );
  const bits = Math.max(...series.slices.map((s) => s.stored.bits));
  const ArrayType = !stored
    ? Float32Array
    : signed
      ? Int16Array
      : bits <= 8
        ? Uint8Array
        : Uint16Array;
  const spacing: Point3 = [series.spacing[1] as number, series.spacing[0] as number, dz];
  return {
    dimensions,
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
    ArrayType,
    /** Voxels hold stored pixel values, not modality units (same order, linear). */
    stored,
    bytes: dimensions[0] * dimensions[1] * dimensions[2] * ArrayType.BYTES_PER_ELEMENT,
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
    dimensions: [width, height, depth],
  } = plan;
  const scalarData = new plan.ArrayType(width * height * depth);
  let min = Infinity;
  let max = -Infinity;
  const finishPlane = async (z: number) => {
    for (let i = z * width * height; i < (z + 1) * width * height; i++) {
      const value = scalarData[i] as number;
      if (!Number.isFinite(value)) throw new Error("Invalid decoded intensity");
      min = Math.min(min, value);
      max = Math.max(max, value);
    }
    progress(z + 1);
    // Allow cancel, slice navigation and progress to paint between planes.
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  // Copy each acquired slice once, no interpolation.
  for (let z = 0; z < depth; z++) {
    signal.throwIfAborted();
    await session.read(z, (image) => {
      signal.throwIfAborted();
      const { pixels, slope, intercept } = intensities(image);
      const scaled = !!image.preScale?.scaled;
      const plane = scalarData.subarray(z * width * height, (z + 1) * width * height);
      for (let i = 0; i < plane.length; i++) {
        const v = pixels[i] as number;
        // Undo the decoder's prescale to recover the stored integer. Float32
        // can't resolve it when the slope is below the value's precision.
        const value = !plan.stored
          ? v * slope + intercept
          : scaled
            ? Math.round((v - image.intercept) / image.slope)
            : v;
        plane[i] = value;
        if (
          plan.stored &&
          (plane[i] !== value ||
            (scaled && Math.fround(value * image.slope + image.intercept) !== v))
        )
          throw new Error("Stored intensity could not be recovered exactly");
      }
    });
    await finishPlane(z);
  }
  return { scalarData, min, max: Math.max(max, min + 1) };
}

/** Pixels plus the modality transform still to apply (none if the decoder prescaled). */
function intensities(image: Types.IImage) {
  if (image.modalityLUT) throw new Error("Nonlinear modality LUT is not supported for 3D");
  const slope = image.preScale?.scaled ? 1 : image.slope;
  const intercept = image.preScale?.scaled ? 0 : image.intercept;
  if (!Number.isFinite(slope) || !Number.isFinite(intercept))
    throw new Error("Invalid intensity transform");
  return { pixels: image.getPixelData(), slope, intercept };
}
