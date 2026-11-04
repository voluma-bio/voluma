/**
 * What the outputs review can align a grid's planes to, in Align's order after the shown grid
 * itself (QuadViewer lists that): every other grid the run published, and every plane fitted
 * (least squares) through the vertices of published surfaces, such as the growth plate's two
 * faces. A grid is any published base or file output whose `detail` carries a `gridId` and its
 * affine (an image volume, or a frame such as intake's joint frame), one per `gridId`. All reach
 * the shown grid through world mm (`@voluma/contracts/ruler`).
 */
import type { OutputState, OutputVersion } from "@voluma/contracts/output-fold";
import type { ReviewAssets } from "@voluma/contracts/review";
import { affineIn, axesOf, directionInGrid, xyzToWorld } from "@voluma/contracts/ruler";
import { fitNormal } from "./frame";
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
  outputs,
  nameOf,
}: {
  revision: Blocks;
  /** The shown grid's image volume. */
  imageId: string;
  assets: Record<string, ReviewAssets>;
  /** The URL prefix of a converted file, ending in "/". */
  assetBase(sha256: string): string;
  fits: readonly PlaneFit[];
  /** The run's published outputs (`OutputsFold.outputs`). */
  outputs: readonly OutputState[];
  /** An output's catalog name ("Joint frame"). */
  nameOf(id: string): string;
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
  // One target per published grid, the first output to publish it naming it.
  const gridOf = (detail: OutputVersion["detail"]) => {
    const affine = affineIn(detail);
    return typeof detail?.gridId === "string" && affine
      ? { gridId: detail.gridId, affine }
      : undefined;
  };
  const seen = new Set([gridOf(outputs.find((o) => o.id === imageId)?.latest?.detail)?.gridId]);
  const grids = outputs.flatMap((o): PlaneTarget[] => {
    const v = o.latest;
    const grid = v && (o.kind === "base" || o.kind === "file") ? gridOf(v.detail) : undefined;
    if (!v || !grid || seen.has(grid.gridId)) return [];
    seen.add(grid.gridId);
    const name = nameOf(o.id);
    return [
      {
        id: `grid:${o.id}`,
        name: `the ${name.charAt(0).toLowerCase()}${name.slice(1)}`,
        tag: v.by,
        load: async () => {
          const [x, y, z] = axesOf(grid.affine);
          const inGrid = (a: readonly [number, number, number]) => directionInGrid(image.affine, a);
          return { axes: [inGrid(z), inGrid(y), inGrid(x)] as const };
        },
      },
    ];
  });
  return [...grids, ...planes];
}
