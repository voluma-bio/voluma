/**
 * The review data the Review lane renders for one scan: grid and affine,
 * labelled structures with mesh files, measurements, the evidence behind
 * them, and per-bone anatomical frames. Taken from the web-review manifest
 * exported by microct-analysis (`bone-morphometry/resources/review-site/
 * export.py`) for OA6-1RK; key names are the manifest's own.
 *
 * Coordinates: `*_zyx` arrays are voxel indices in Z,Y,X order (array order);
 * `*_xyz` are voxel-centre indices in X,Y,Z order; `*_scene_mm` are millimetres
 * relative to `center_world_mm`, the viewer's origin; `*_uvw` are voxel
 * indices in a bone's aligned grid (see `frames`).
 */
import { z } from "zod";

const vec3 = z.tuple([z.number(), z.number(), z.number()]);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);

/** One labelled structure and its surface mesh. */
export const structureSchema = z.object({
  /** Label value in the segmentation; 13+ are aligned-grid display masks. */
  label: z.number().int().positive(),
  name: z.string(),
  /** Seed voxels (Z,Y,X) the structure was grown from; absent for derived masks. */
  points_zyx: z.array(vec3).optional(),
  definition: z.string().optional(),
  /** CSS hex colour for the viewer. */
  color: z.string().regex(/^#[0-9a-f]{6}$/i),
  volume_mm3: z.number(),
  /**
   * Mesh file next to the manifest: `vertices` little-endian float32 xyz
   * positions (scene mm) then `indices` little-endian uint32 triangle corners.
   */
  file: z.string(),
  vertices: z.number().int().nonnegative(),
  indices: z.number().int().nonnegative(),
  sha256,
});
export type Structure = z.infer<typeof structureSchema>;

/**
 * One measurement. Distances carry the endpoints they were taken between;
 * ratios name their operands; volumes name the label they were counted from.
 * Fields beyond `value` and `unit` appear only where they apply.
 */
export const measurementSchema = z.object({
  value: z.number(),
  /** `mm`, `mm^3`, `1/mm`, or `1` for a dimensionless ratio. */
  unit: z.string(),
  title: z.string().optional(),
  definition: z.string().optional(),
  /** Review state in words, e.g. "Provisional: boundary/ROI review required". */
  status: z.string().optional(),
  /** Bone the measurement belongs to. */
  bone: z.string().optional(),
  /** Structure label the measurement was counted from or drawn on. */
  label: z.number().int().positive().optional(),
  /** Ratios: keys of the measurements divided. */
  numerator: z.string().optional(),
  denominator: z.string().optional(),
  /** Distance endpoints: voxel-centre indices X,Y,Z. */
  points_xyz: z.array(vec3).length(2).optional(),
  /** The same endpoints in scene mm. */
  points_scene_mm: z.array(vec3).length(2).optional(),
  /** The same endpoints in the bone's aligned grid (U,V,W voxel indices). */
  points_aligned_uvw: z.array(vec3).length(2).optional(),
  distance_method: z.string().optional(),
  /** Evidence stage whose files show this measurement. */
  evidence_stage: z.string().optional(),
  /** Plate-thickness patch: voxel index ranges [from, to] on the aligned U and V axes. */
  patch: z
    .object({ u: z.tuple([z.number(), z.number()]), v: z.tuple([z.number(), z.number()]) })
    .optional(),
  mean_mm: z.number().optional(),
  p10_p90_mm: z.tuple([z.number(), z.number()]).optional(),
  columns: z.number().int().optional(),
  columns_over_035mm: z.number().int().optional(),
});
export type Measurement = z.infer<typeof measurementSchema>;

/** A file that backs the numbers: a figure, script or report from one pipeline stage. */
export const evidenceFileSchema = z.object({
  /** Path relative to the manifest. */
  path: z.string(),
  stage: z.string(),
  name: z.string(),
  sha256,
});
export type EvidenceFile = z.infer<typeof evidenceFileSchema>;

/**
 * A bone's anatomical frame: shaft axis fit used to align the scan. Bases and
 * origins are in voxel XYZ of the original grid. The aligned-grid fields exist
 * only for bones resampled into an aligned grid (the tibia).
 */
export const boneFrameSchema = z.object({
  /** Columns are the frame's U, V, W axes. */
  basis_columns_xyz: z.tuple([vec3, vec3, vec3]),
  origin_xyz: vec3,
  shaft_centers_xyz: z.array(vec3),
  shaft_z_range: z.tuple([z.number(), z.number()]),
  epiphysis_z_range: z.tuple([z.number(), z.number()]),
  method: z.string(),
  local_lower_uvw: vec3.optional(),
  aligned_shape_zyx: vec3.optional(),
  output_xyz_to_original_xyz_matrix: z.tuple([vec3, vec3, vec3]).optional(),
  output_xyz_to_original_xyz_offset: vec3.optional(),
});
export type BoneFrame = z.infer<typeof boneFrameSchema>;

/** Review-deck text for a measurement that replaces the deck's defaults. */
export const parameterOverrideSchema = z.object({
  source_measurement: z.string(),
  status: z.string(),
  labels: z.array(z.number().int().positive()),
  context: z.string(),
  method: z.string(),
  unit: z.string(),
  related_measurements: z.array(z.string()).optional(),
});
export type ParameterOverride = z.infer<typeof parameterOverrideSchema>;

export const reviewDataSchema = z.object({
  sample: z.string(),
  /** Identifies the voxel grid every `*_zyx`/`*_xyz` coordinate refers to. */
  grid_id: sha256,
  /** 4x4 voxel XYZ to world mm. */
  affine: z.tuple([
    z.tuple([z.number(), z.number(), z.number(), z.number()]),
    z.tuple([z.number(), z.number(), z.number(), z.number()]),
    z.tuple([z.number(), z.number(), z.number(), z.number()]),
    z.tuple([z.number(), z.number(), z.number(), z.number()]),
  ]),
  /** World mm of the grid centre; mesh and `*_scene_mm` coordinates are relative to it. */
  center_world_mm: vec3,
  shape_zyx: vec3,
  structures: z.array(structureSchema),
  /** Keyed by measurement id. */
  measurements: z.record(z.string(), measurementSchema),
  evidence: z.array(evidenceFileSchema),
  /** Keyed by bone name (`femur`, `tibia`). */
  frames: z.record(z.string(), boneFrameSchema),
  /** Keyed by parameter number as a string. */
  parameter_overrides: z.record(z.string(), parameterOverrideSchema),
  /** How the surfaces were produced, for display. */
  display: z.string(),
});
export type ReviewData = z.infer<typeof reviewDataSchema>;
