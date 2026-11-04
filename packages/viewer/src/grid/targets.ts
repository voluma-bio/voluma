/**
 * What the outputs review can align a grid's planes to, in Align's order after the shown grid
 * itself (QuadViewer lists that): the frames tasks oriented for, every plane fitted
 * (least squares) through the vertices of published surfaces, such as the growth plate's two
 * faces, then the other grids the run published. A grid is any published base or file output whose `detail` carries a `gridId` and its
 * affine (an image volume, or a frame such as intake's joint frame), one per `gridId`. All reach
 * the shown grid through world mm (`@voluma/contracts/ruler`).
 */
import type { Grid, ReviewAssets } from "@voluma/contracts/review";
import { axesOf, directionInGrid, xyzToWorld } from "@voluma/contracts/ruler";
import { dot, fitNormal } from "./frame";
import type { PlaneTarget } from "./QuadViewer";
import type { Blocks } from "./review";

/** A plane fitted through surfaces: its view's code ("GP"), its name in words, the surfaces' ids. */
export type PlaneFit = { code: string; name: string; surfaces: readonly string[] };

export function planeTargets({
  revision,
  imageId,
  assets,
  assetBase,
  fits,
  grids,
}: {
  revision: Blocks;
  /** The shown grid's image volume. */
  imageId: string;
  assets: Record<string, ReviewAssets>;
  /** The URL prefix of a converted file, ending in "/". */
  assetBase(sha256: string): string;
  fits: readonly PlaneFit[];
  /** Every grid the run published (`outputBlocks`), the shown one included. */
  grids: readonly Grid[];
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
              return xyzToWorld(s.on.affine, xyz);
            }),
          ),
        );
        const normal = fitNormal(points);
        if (!normal) throw new Error("the surfaces have too few points");
        return { normal: directionInGrid(image.affine, normal) };
      },
    };
  });
  // A grid whose axes are the shown grid's (any run published before the harness wrote poses
  // gives every grid the scan's) would only do what Reset does.
  const [ix, iy, iz] = axesOf(image.affine);
  const same = (g: Grid) =>
    axesOf(g.affine).every((a, k) => Math.abs(dot(a, [ix, iy, iz][k]!)) > 1 - 1e-9);
  const targetOf = (g: Grid): PlaneTarget => ({
    id: `grid:${g.id}`,
    name: `the ${g.name.charAt(0).toLowerCase()}${g.name.slice(1)}`,
    tag: g.by,
    load: async () => {
      const [x, y, z] = axesOf(g.affine);
      const inGrid = (a: readonly [number, number, number]) => directionInGrid(image.affine, a);
      return { axes: [inGrid(z), inGrid(y), inGrid(x)] as const };
    },
  });
  const other = grids.filter((g) => g.id !== imageId && !same(g));
  // Frames a task oriented for come before the plane fits, other grids after them.
  return [
    ...other.filter((g) => g.kind === "file").map(targetOf),
    ...planes,
    ...other.filter((g) => g.kind === "base").map(targetOf),
  ];
}
