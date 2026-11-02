/**
 * A run's thumbnail: one plane through the middle of its scan, read from the coarse OME-Zarr
 * levels the review converter already wrote (so no source volume is touched), windowed to 8 bits
 * and stored as a WebP under the run's own prefix, keyed by the run's generation. Rendered at the
 * first request and kept; a run with no converted image yet has none.
 *
 * Which converted file is the scan comes from the files alone, so both loops' runs work (the agent
 * loop has no plan to name it): of the volumes the converter wrote as `image` (the kind it records
 * in `image.zarr/.zattrs`), the one with the most voxels, since every other image is derived from
 * the scan and none is larger; on a tie, the first in the log.
 */
import { reviewAssetKey, runThumbnailKey } from "@voluma/contracts/r2";
import type { ReviewAssets } from "@voluma/contracts/review";
import { ObjectNotFound, type ObjectStore } from "@voluma/object-store";
import sharp from "sharp";
import * as zarr from "zarrita";

/** Planes smaller than this on their long side are skipped for the next finer level. */
const MIN_SIDE = 160;
const MAX_SIDE = 192;
/** The window shows the middle of the values: dark and bright outliers clip. */
const LOW = 0.01;
const HIGH = 0.995;

type Level = { path: string; shapeZyx: number[] };

function assetStore(store: ObjectStore, runId: string, sha256: string): zarr.Readable {
  return {
    async get(key) {
      try {
        const { body } = await store.get(reviewAssetKey(runId, sha256, key.slice(1)));
        return new Uint8Array(await new Response(body).arrayBuffer());
      } catch (error) {
        if (error instanceof ObjectNotFound) return undefined;
        throw error;
      }
    },
  };
}

/** The plane through the middle of the shortest axis: it keeps the two longest in view. */
function planeAxes(shape: number[]) {
  const cut = shape.indexOf(Math.min(...shape));
  return { cut, keep: [0, 1, 2].filter((a) => a !== cut) };
}

/** The coarsest level whose plane is still big enough to scale down from. */
function pickLevel(levels: Level[]): Level {
  for (const level of [...levels].reverse()) {
    const { keep } = planeAxes(level.shapeZyx);
    if (Math.max(...keep.map((a) => level.shapeZyx[a] ?? 0)) >= MIN_SIDE) return level;
  }
  return levels[0] as Level;
}

/** The converted `image` volume with the most voxels in `assets`; undefined when there is none. */
async function findScan(store: ObjectStore, runId: string, assets: Record<string, ReviewAssets>) {
  const candidates = Object.entries(assets).flatMap(([sha256, asset]) =>
    asset.state === "ready" && asset.levels[0] ? [{ sha256, levels: asset.levels }] : [],
  );
  const kinds = await Promise.all(
    candidates.map(async ({ sha256 }) => {
      const group = await zarr.open.v2(
        zarr.root(assetStore(store, runId, sha256)).resolve("image.zarr"),
        {
          kind: "group",
        },
      );
      const multiscales = group.attrs.multiscales as { name?: string }[] | undefined;
      return multiscales?.[0]?.name;
    }),
  );
  const voxels = (levels: Level[]) => (levels[0]?.shapeZyx ?? []).reduce((a, b) => a * b, 1);
  let scan: (typeof candidates)[number] | undefined;
  candidates.forEach((candidate, i) => {
    if (kinds[i] === "image" && (!scan || voxels(candidate.levels) > voxels(scan.levels)))
      scan = candidate;
  });
  return scan;
}

/** Renders the scan in `assets` (`findScan`); null when there is none. */
async function renderThumbnail(
  store: ObjectStore,
  runId: string,
  assets: Record<string, ReviewAssets>,
): Promise<Uint8Array | null> {
  const scan = await findScan(store, runId, assets);
  if (!scan) return null;
  const level = pickLevel(scan.levels);
  const root = zarr.root(assetStore(store, runId, scan.sha256));
  const array = await zarr.open.v2(root.resolve(level.path), { kind: "array" });
  const { cut } = planeAxes(array.shape);
  const selection = [null, null, null] as (number | null)[];
  selection[cut] = Math.floor((array.shape[cut] ?? 0) / 2);
  const plane = await zarr.get(array, selection);
  const values = Float64Array.from(plane.data as ArrayLike<number>);
  // A float32 image may hold NaN, which sorts last and would take the top of the window.
  const sorted = values.filter(Number.isFinite).sort();
  const lo = sorted[Math.floor(LOW * (sorted.length - 1))] ?? 0;
  const hi = sorted[Math.floor(HIGH * (sorted.length - 1))] ?? 0;
  const gray = Uint8Array.from(values, (v) =>
    hi > lo && Number.isFinite(v)
      ? Math.round(255 * Math.min(1, Math.max(0, (v - lo) / (hi - lo))))
      : 0,
  );
  const [rows, cols] = plane.shape as [number, number];
  return sharp(gray, { raw: { width: cols, height: rows, channels: 1 } })
    .resize(MAX_SIDE, MAX_SIDE, { fit: "inside" })
    .webp({ quality: 80 })
    .toBuffer();
}

/** Requests for one run generation that arrive while it renders share the render. */
const rendering = new Map<string, Promise<Uint8Array | null>>();

/** Serves from the store, or renders and stores. Null when the run has nothing to render yet. */
export async function runThumbnail(
  store: ObjectStore,
  runId: string,
  generation: string,
  assets: () => Promise<Record<string, ReviewAssets> | null>,
): Promise<Uint8Array | null> {
  const key = runThumbnailKey(runId, generation);
  try {
    const { body } = await store.get(key);
    return new Uint8Array(await new Response(body).arrayBuffer());
  } catch (error) {
    if (!(error instanceof ObjectNotFound)) throw error;
  }
  let pending = rendering.get(key);
  if (!pending) {
    pending = (async () => {
      const found = await assets();
      const webp = found && (await renderThumbnail(store, runId, found));
      if (!webp) return null;
      await store.put(key, webp, { contentType: "image/webp" });
      return webp;
    })().finally(() => rendering.delete(key));
    rendering.set(key, pending);
  }
  return pending;
}
