/**
 * The review's building blocks: the shapes the viewer draws and the converter's manifest.
 * Nothing here is stored as a document; the agent loop's outputs (`output-fold.ts`) name these
 * blocks and the run view reads them.
 *
 * - `volumes`, `structures`, `surfaces` and `annotations`: a closed set the shell knows how to
 *   render. A workflow fills them with what it has; it cannot invent a new kind. A kind the
 *   shell cannot draw is a small contract PR that adds a block, not a field on an old one.
 *
 * Coordinates: annotations are world mm; the UI converts to voxels through the volume's
 * `affine`. Structures and surfaces are voxels on their grid.
 *
 * Converted assets (`ReviewAssets`) are one map for the run, keyed by the sha256 of the file a
 * block points at: absent means still preparing.
 *
 * Files are stored as full R2 keys (`storedKeySchema`), always produced by an `r2.ts` builder:
 * `evidenceKey(runId, sha256)` for run files. Never a path relative to some root. Converted
 * review assets (`reviewAssetKey`) are not stored: the assets route builds their keys from the
 * manifest.
 */
import { z } from "zod";
import {
  relativePathSchema,
  sha256Schema as sha256,
  storedKeySchema,
  storedPrefixSchema,
} from "./r2";

/** A position or direction in world mm. */
const vec3 = z.tuple([z.number(), z.number(), z.number()]);
const row4 = z.tuple([z.number(), z.number(), z.number(), z.number()]);
type R4 = z.infer<typeof row4>;

/** A grid's shape `[z, y, x]`. */
export const shapeZyxSchema = z.tuple([
  z.number().int().positive(),
  z.number().int().positive(),
  z.number().int().positive(),
]);

/** A voxel index `[z, y, x]` of a grid. */
export const voxelIndexSchema = z.tuple([z.int().min(0), z.int().min(0), z.int().min(0)]);

/** An inclusive box in voxel indices `[z, y, x]`; `min` must not exceed `max` on any axis. */
export const voxelBoxSchema = z
  .object({ min: voxelIndexSchema, max: voxelIndexSchema })
  .refine((b) => b.min.every((lo, i) => lo <= (b.max[i] ?? lo)), {
    message: "box.min must not exceed box.max on any axis",
  });

/**
 * What the converter (`workflows/core/convert/review_assets.py`) prints and writes as
 * `manifest.json`; the runner parses it and builds `assets.ready` from it. Paths are relative
 * to the asset prefix (`reviewAssetKey` in `r2.ts`). It carries no `sourceSha256`: the runner knows which
 * file it converted, and identity is never taken from subprocess output. Other keys in the
 * printed JSON are ignored.
 */
export const reviewAssetsManifestSchema = z.object({
  /** OME-Zarr levels, finest first; `scaleZyx` is source voxels per level voxel on each axis. */
  levels: z.array(
    z.object({ path: relativePathSchema, shapeZyx: shapeZyxSchema, scaleZyx: shapeZyxSchema }),
  ),
  /**
   * Surface meshes: float32 vertices (x, y, z) in voxels of the source grid at full resolution,
   * then uint32 triangle indices, little-endian. `label` is set for a labels volume's mesh.
   */
  meshes: z.array(
    z.object({
      label: z.number().int().positive().optional(),
      path: relativePathSchema,
      vertices: z.number().int().nonnegative(),
      indices: z
        .number()
        .int()
        .nonnegative()
        .refine((n) => n % 3 === 0, "indices come in triangles"),
    }),
  ),
});
export type ReviewAssetsManifest = z.infer<typeof reviewAssetsManifestSchema>;

/** The converted assets of one reported file, or why there are none. */
export const reviewAssetsSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("ready"), ...reviewAssetsManifestSchema.shape }),
  z.object({ state: z.literal("failed"), error: z.string().min(1) }),
]);
export type ReviewAssets = z.infer<typeof reviewAssetsSchema>;

/** Voxel types the viewer loads: intensities for `image` volumes, label values for `labels` volumes. */
export const imageDtype = z.enum(["int16", "uint16", "float32"]);
export const labelDtype = z.enum(["uint8", "uint16"]);

/** Every voxel type an `.npy` volume may hold. */
export const npyDtypeSchema = z.enum([...imageDtype.options, ...labelDtype.options]);

/** Where a volume's voxels are stored, in a format the viewer loads. */
export const volumeDataSchema = z.discriminatedUnion("format", [
  /**
   * A DICOM series: the `.dcm` files under `prefix`, the series with this UID.
   * The volume's `affine` and `shapeZyx` must equal the series' header geometry
   * (the viewer takes world space from the headers and ignores our copy).
   */
  z.object({ format: z.literal("dicom"), prefix: storedPrefixSchema, seriesId: z.string() }),
  /**
   * An `.npy` array in C order, shaped `shapeZyx`, of type `dtype`: `image`
   * volumes `int16 | uint16 | float32`, `labels` volumes `uint8 | uint16`.
   * Producers convert other numpy types (int32, bool) on upload.
   */
  z.object({
    format: z.literal("npy"),
    key: storedKeySchema,
    sha256,
    dtype: npyDtypeSchema,
  }),
]);

/** Orthogonal, nonzero columns in the 3x3 part and a bottom row of 0,0,0,1. */
function isSpacedRigid(m: [R4, R4, R4, R4]): boolean {
  const col = (j: 0 | 1 | 2) => [m[0][j], m[1][j], m[2][j]] as const;
  const dot = (a: readonly [number, number, number], b: readonly [number, number, number]) =>
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const [c0, c1, c2] = [col(0), col(1), col(2)];
  const near0 = (a: readonly [number, number, number], b: readonly [number, number, number]) =>
    Math.abs(dot(a, b)) <= 1e-4 * Math.sqrt(dot(a, a) * dot(b, b));
  return (
    dot(c0, c0) > 0 &&
    dot(c1, c1) > 0 &&
    dot(c2, c2) > 0 &&
    near0(c0, c1) &&
    near0(c0, c2) &&
    near0(c1, c2) &&
    m[3].join() === "0,0,0,1"
  );
}

/**
 * A voxel grid the viewer slices: the scan, a derived volume (an aligned
 * grid), or a label map. Several volumes can share one affine.
 */
export const volumeSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** `image` shows intensities; `labels` holds the label values of `Structure.voxels`. */
  kind: z.enum(["image", "labels"]),
  shapeZyx: shapeZyxSchema,
  /**
   * 4x4 row-major: voxel index (x,y,z) to world mm. The 3x3 part has
   * orthogonal columns (their lengths are the positive voxel spacings).
   */
  affine: z
    .tuple([row4, row4, row4, row4])
    .refine(isSpacedRigid, "affine needs orthogonal, nonzero columns and a bottom row of 0,0,0,1"),
  /** What the values are: `"HU"`, `"mm"`; null for raw or unitless. */
  unit: z.string().nullable(),
  /**
   * The grid id the producer wrote beside the array (the `.npy` sidecar's `grid_id`). A
   * structure mask, surface or annotation reports the id of the grid it was made on, and
   * is refused when it differs: frames share spacing, so a wrong grid's voxels would pass.
   * Blocks on this volume name it by its block `id`, as `volumeId`; `gridId` means only this.
   */
  gridId: z.string().min(1),
  /** Null when the producer ships the volume in no loadable format. */
  data: volumeDataSchema.nullable(),
});
export type Volume = z.infer<typeof volumeSchema>;

/**
 * A grid the run published, image or not: a base output's grid, or a frame a task oriented for (a
 * file output such as intake's joint frame), named by the output that first published it.
 */
export type Grid = {
  /** The output that published it. */
  id: string;
  name: string;
  /** The task that published it ("intake"). */
  by: string;
  kind: "base" | "file";
  affine: Volume["affine"];
};

/** A segmented object: a label in a `labels` volume, or a cropped mask on a grid. */
export const structureSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    /** The volume it sits on; null when that volume isn't reported. */
    volumeId: z.string().nullable(),
    /**
     * Where its voxels are: a value in the `labels` volume; or a uint8 mask cropped to its
     * bounding box, placed on the volume at `offsetZyx` (its levels and mesh are in crop voxels:
     * add the offset). Null when the structure is reported missing or its volume isn't reported.
     */
    voxels: z
      .union([
        z.object({ label: z.number().int().positive() }),
        z.object({
          mask: z.object({ key: storedKeySchema, sha256, shapeZyx: shapeZyxSchema }),
          offsetZyx: voxelIndexSchema,
        }),
      ])
      .nullable(),
    /** Set when the task reported the structure as missing (not in the field of view): why. */
    missing: z.object({ reason: z.string().min(1) }).nullable(),
    definition: z.string().optional(),
    volumeMm3: z.number().optional(),
  })
  .refine((s) => s.voxels === null || s.volumeId !== null, {
    path: ["volumeId"],
    message: "a structure with voxels names its volume",
  });
export type Structure = z.infer<typeof structureSchema>;

/** A traced face as a height field on a grid, drawn as a line in the slices and a mesh in 3D. */
export const surfaceSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** The volume it is a height field on. */
  volumeId: z.string(),
  /** The array axis the heights are measured along. */
  axis: z.literal([0, 1, 2]),
  /** float32, the grid's shape without `axis`; NaN where the surface leaves the bone. */
  heights: z.object({ key: storedKeySchema, sha256 }),
});
export type Surface = z.infer<typeof surfaceSchema>;

const annotationBase = {
  id: z.string(),
  name: z.string(),
  /** The volume it was placed on (the one whose slices show it first). */
  volumeId: z.string(),
  /** The producer's own description, e.g. how a landmark was placed. */
  note: z.string().optional(),
};

/** A landmark. */
export const pointAnnotationSchema = z.object({
  ...annotationBase,
  kind: z.literal("point"),
  position: vec3,
});
/** A ruler between two endpoints, or an axis. */
export const lineAnnotationSchema = z.object({
  ...annotationBase,
  kind: z.literal("line"),
  a: vec3,
  b: vec3,
});

/**
 * Something drawn in the views. Positions are world mm. The shell renders
 * every kind; a workflow chooses which to supply. A region of interest is a
 * structure, not an annotation. Next kinds (`plane`, `region`, `path`) are in
 * `.context/TODO.md`.
 */
export const annotationSchema = z.discriminatedUnion("kind", [
  pointAnnotationSchema,
  lineAnnotationSchema,
]);
export type Annotation = z.infer<typeof annotationSchema>;

/** A file that backs a number or is offered for download: a figure, script or report. */
export const assetSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Pipeline stage that produced it. */
  stage: z.string(),
  key: storedKeySchema,
  sha256,
  /** Set for a file the workflow declared a media type for; absent for evidence. */
  mediaType: z.string().optional(),
});
export type Asset = z.infer<typeof assetSchema>;

/**
 * What a To check item points at, so the review can outline it. Absent on an
 * item means the whole task. `on` names blocks of any kind (volume, structure,
 * surface, annotation) to outline. All coordinates are voxel indices on the scan's
 * grid, in [z, y, x] order, never world mm. `volumeId` is a labels volume (a
 * disagreement mask); `label` picks one region in it, so it needs `volumeId`.
 * `box` is inclusive; `point` is where the crosshair centres.
 */
export const focusSchema = z
  .object({
    on: z.array(z.string()),
    volumeId: z.string().optional(),
    label: z.int().min(1).optional(),
    box: voxelBoxSchema.optional(),
    point: voxelIndexSchema.optional(),
  })
  .refine((f) => f.label === undefined || f.volumeId !== undefined, {
    path: ["label"],
    message: "label needs volumeId",
  });
export type Focus = z.infer<typeof focusSchema>;
