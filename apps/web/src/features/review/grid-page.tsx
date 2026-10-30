/**
 * `/runs/:runId/grid`: one analysis grid of a run in the grid viewer, from the converted review
 * assets the query names, before the review picks them from the run's own blocks. Each source
 * is a sha256 under the run's assets route; its `manifest.json` gives levels and meshes.
 *   ?image=<sha256>                  the grid's image (its finest level fixes the grid's shape)
 *   &labels=<sha256>                 a labels volume on the whole grid (repeatable)
 *   &mask=<sha256>@<z>,<y>,<x>       a cropped mask and where it sits (repeatable)
 *   &surface=<sha256>@<z>,<y>,<x>    a surface's mesh (repeatable; offset optional)
 *   &spacing=<mm>                    the grid's voxel size (isotropic)
 */
import { useQuery } from "@tanstack/react-query";
import { reviewAssetUrl } from "@voluma/api-client";
import { type ReviewAssetsManifest, reviewAssetsManifestSchema } from "@voluma/contracts/review";
import {
  type GridMesh,
  type GridScene,
  GridViewer,
  type Overlay,
  type Zyx,
} from "@voluma/viewer/grid";
import { useMemo } from "react";
import { Link, useParams, useSearchParams } from "react-router";

const token = (name: string) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/** `sha256` or `sha256@z,y,x`. */
function parseSource(value: string): { sha256: string; offsetZyx: Zyx } {
  const [sha256 = "", at] = value.split("@");
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error(`"${value}" does not start with a sha256.`);
  const offset = at?.split(",").map(Number) ?? [0, 0, 0];
  if (offset.length !== 3 || offset.some((n) => !Number.isInteger(n) || n < 0))
    throw new Error(`"${value}": the offset must be three whole voxel counts, z,y,x.`);
  return { sha256, offsetZyx: offset as unknown as Zyx };
}

async function loadScene(runId: string, search: URLSearchParams): Promise<GridScene> {
  const image = search.get("image");
  const spacing = Number(search.get("spacing"));
  if (!image) throw new Error("Name the grid's image: ?image=<sha256>.");
  if (!/^[0-9a-f]{64}$/.test(image)) throw new Error(`"${image}" is not a sha256.`);
  if (!(spacing > 0)) throw new Error("Give the grid's voxel size in mm: &spacing=0.0105.");
  const base = (sha256: string) =>
    new URL(reviewAssetUrl(runId, sha256, "x").slice(0, -1), location.href).href;
  const manifest = async (sha256: string) => {
    const response = await fetch(`${base(sha256)}manifest.json`);
    if (response.status === 404) throw new Error(`No converted assets for ${sha256.slice(0, 8)}.`);
    if (!response.ok) throw new Error(`Assets of ${sha256.slice(0, 8)}: HTTP ${response.status}.`);
    return reviewAssetsManifestSchema.parse(await response.json());
  };
  const sources = (key: string) => search.getAll(key).map(parseSource);
  const labels = sources("labels");
  const masks = sources("mask");
  const surfaces = sources("surface");
  const [imageManifest, ...rest] = await Promise.all(
    [image, ...[...labels, ...masks, ...surfaces].map((s) => s.sha256)].map(manifest),
  );
  const finest = imageManifest!.levels[0];
  if (!finest) throw new Error("The image has no levels.");
  const overlays: Overlay[] = [];
  const meshes: GridMesh[] = [];
  const mesh =
    (sha256: string, offsetZyx: Zyx, color: string, opacity: number) =>
    (m: ReviewAssetsManifest["meshes"][number]): GridMesh => ({
      id: `${sha256}/${m.path}`,
      name: m.label ? `label ${m.label}` : sha256.slice(0, 8),
      url: `${base(sha256)}${m.path}`,
      vertices: m.vertices,
      indices: m.indices,
      offsetZyx,
      color,
      opacity,
    });
  let colour = 0;
  const nextColour = () => token(`--label-${(colour++ % 12) + 1}`);
  [...labels, ...masks, ...surfaces].forEach((source, i) => {
    const m = rest[i]!;
    const kind =
      i < labels.length ? "labels" : i < labels.length + masks.length ? "mask" : "surface";
    if (kind === "labels") {
      overlays.push({
        id: source.sha256,
        name: `labels ${source.sha256.slice(0, 8)}`,
        base: base(source.sha256),
        levels: m.levels,
        offsetZyx: source.offsetZyx,
        color: Object.fromEntries(
          Array.from({ length: 255 }, (_, n) => [n + 1, token(`--label-${(n % 12) + 1}`)]),
        ),
      });
      // Bones as see-through ivory shells, so what lies inside them shows.
      meshes.push(...m.meshes.map(mesh(source.sha256, source.offsetZyx, token("--bone"), 0.35)));
      return;
    }
    const color = nextColour();
    if (kind === "mask")
      overlays.push({
        id: source.sha256,
        name: `mask ${source.sha256.slice(0, 8)}`,
        base: base(source.sha256),
        levels: m.levels,
        offsetZyx: source.offsetZyx,
        color,
      });
    meshes.push(...m.meshes.map(mesh(source.sha256, source.offsetZyx, color, 1)));
  });
  return {
    shapeZyx: finest.shapeZyx,
    spacingZyx: [spacing, spacing, spacing],
    image: { base: base(image), levels: imageManifest!.levels },
    overlays,
    meshes,
  };
}

export function GridPage() {
  const { runId = "" } = useParams();
  const [search] = useSearchParams();
  const key = search.toString();
  const scene = useQuery({
    queryKey: ["grid-scene", runId, key],
    queryFn: () => loadScene(runId, new URLSearchParams(key)),
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const back = useMemo(
    () => <Link to={`/runs/${encodeURIComponent(runId)}`}>Back to review</Link>,
    [runId],
  );
  return (
    <main className="review-shell" data-theme="light">
      {scene.data ? (
        <GridViewer key={key} scene={scene.data}>
          {back}
        </GridViewer>
      ) : (
        <div className="view-empty" role={scene.isError ? "alert" : "status"}>
          <p className="font-medium">
            {scene.isError ? (scene.error as Error).message : "Loading the grid's assets…"}
          </p>
          <p className="mt-2">{back}</p>
        </div>
      )}
    </main>
  );
}
