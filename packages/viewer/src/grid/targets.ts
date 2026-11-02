/**
 * What the outputs review can align a grid's planes to, from the run's blocks: a plane fitted
 * (least squares) through the vertices of published surfaces, such as the growth plate's two
 * faces, and every other grid's axes. Both reach the shown grid through world mm: each volume's
 * affine maps its voxels (x, y, z) to world, with orthogonal columns.
 */
import type { ReviewAssets, Volume } from "@voluma/contracts/review";
import { fitNormal, type Vec3 } from "./frame";
import type { PlaneTarget } from "./QuadViewer";
import type { Blocks } from "./review";

/** A plane fitted through surfaces: its view's code ("GP"), its name in words, the surfaces' ids. */
export type PlaneFit = { code: string; name: string; surfaces: readonly string[] };

/** A volume's axes as world unit vectors, x, y, z (the affine's columns). */
const axesOf = (v: Volume): [Vec3, Vec3, Vec3] =>
  [0, 1, 2].map((j) => {
    const col: Vec3 = [v.affine[0][j]!, v.affine[1][j]!, v.affine[2][j]!];
    const n = Math.hypot(...col);
    return [col[0] / n, col[1] / n, col[2] / n];
  }) as unknown as [Vec3, Vec3, Vec3];

/** A world direction in the grid's mm, (z, y, x). */
function inGrid(image: Volume, world: Vec3): Vec3 {
  const [x, y, z] = axesOf(image);
  const d = (a: Vec3) => a[0] * world[0] + a[1] * world[1] + a[2] * world[2];
  return [d(z), d(y), d(x)];
}

export function planeTargets({
  revision,
  imageId,
  assets,
  assetBase,
  fits,
}: {
  revision: Blocks;
  /** The shown grid's image volume. */
  imageId: string;
  assets: Record<string, ReviewAssets>;
  /** The URL prefix of a converted file, ending in "/". */
  assetBase(sha256: string): string;
  fits: readonly PlaneFit[];
}): PlaneTarget[] {
  const image = revision.volumes.find((v) => v.id === imageId);
  if (!image) return [];
  const volumes = new Map(revision.volumes.map((v) => [v.id, v]));
  const planes = fits.map((fit): PlaneTarget => {
    const surfaces = revision.surfaces.flatMap((s) => {
      const on = volumes.get(s.volumeId);
      const a = assets[s.heights.sha256];
      return fit.surfaces.includes(s.id) && on && a?.state === "ready"
        ? [{ on, sha256: s.heights.sha256, meshes: a.meshes }]
        : [];
    });
    const base = { id: `plane:${fit.code}`, name: fit.name, code: fit.code };
    if (!surfaces.length) return { ...base, reason: "Not traced yet" };
    return {
      ...base,
      async load() {
        // Every vertex in world mm, then one plane through them all.
        const points = await Promise.all(
          surfaces.flatMap((s) =>
            s.meshes.map(async (m) => {
              const response = await fetch(`${assetBase(s.sha256)}${m.path}`);
              if (!response.ok) throw new Error(`HTTP ${response.status}`);
              const xyz = new Float32Array(await response.arrayBuffer(), 0, m.vertices * 3);
              const a = s.on.affine;
              const world = new Float64Array(xyz.length);
              for (let i = 0; i < xyz.length; i += 3)
                for (let r = 0; r < 3; r++)
                  world[i + r] =
                    a[r]![0]! * xyz[i]! +
                    a[r]![1]! * xyz[i + 1]! +
                    a[r]![2]! * xyz[i + 2]! +
                    a[r]![3]!;
              return world;
            }),
          ),
        );
        const normal = fitNormal(points);
        if (!normal) throw new Error("the surfaces have too few points");
        return { normal: inGrid(image, normal) };
      },
    };
  });
  const grids = revision.volumes
    .filter((v) => v.kind === "image" && v.gridId !== image.gridId && v.data)
    .map(
      (v): PlaneTarget => ({
        id: `grid:${v.id}`,
        name: `the ${v.name.charAt(0).toLowerCase()}${v.name.slice(1)}`,
        load: async () => {
          const [x, y, z] = axesOf(v);
          return { axes: [inGrid(image, z), inGrid(image, y), inGrid(image, x)] as const };
        },
      }),
    );
  return [...planes, ...grids];
}
