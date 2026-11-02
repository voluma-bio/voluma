/**
 * A run's thumbnail: one plane through the middle of its first converted image volume, read from
 * the coarse OME-Zarr levels the review converter already wrote (so no source volume is touched),
 * windowed to 8 bits and stored as a WebP under the run's own prefix. Rendered at the first
 * request and kept; a run with no converted image volume yet has none.
 */

import { reviewAssetKey, runThumbnailKey } from "@voluma/contracts/r2";
import type { ReviewRun } from "@voluma/contracts/review";
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

/** The latest revision's first image volume whose levels are converted. */
export function thumbnailSource(review: ReviewRun) {
  const revision = review.revisions.at(-1);
  for (const volume of revision?.volumes ?? []) {
    if (volume.kind !== "image" || volume.data?.format !== "npy") continue;
    const assets = review.assets[volume.data.sha256];
    if (assets?.state === "ready" && assets.levels.length > 0)
      return { sha256: volume.data.sha256, levels: assets.levels };
  }
  return null;
}

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

export async function renderThumbnail(
  store: ObjectStore,
  runId: string,
  source: NonNullable<ReturnType<typeof thumbnailSource>>,
): Promise<Uint8Array> {
  const level = pickLevel(source.levels);
  const root = zarr.root(assetStore(store, runId, source.sha256));
  const array = await zarr.open.v2(root.resolve(level.path), { kind: "array" });
  const { cut } = planeAxes(array.shape);
  const selection = [null, null, null] as (number | null)[];
  selection[cut] = Math.floor((array.shape[cut] ?? 0) / 2);
  const plane = await zarr.get(array, selection);
  const values = Float64Array.from(plane.data as ArrayLike<number>);
  const sorted = Float64Array.from(values).sort();
  const lo = sorted[Math.floor(LOW * (sorted.length - 1))] ?? 0;
  const hi = sorted[Math.floor(HIGH * (sorted.length - 1))] ?? 0;
  const gray = Uint8Array.from(values, (v) =>
    hi > lo ? Math.round(255 * Math.min(1, Math.max(0, (v - lo) / (hi - lo)))) : 0,
  );
  const [rows, cols] = plane.shape as [number, number];
  return sharp(gray, { raw: { width: cols, height: rows, channels: 1 } })
    .resize(MAX_SIDE, MAX_SIDE, { fit: "inside" })
    .webp({ quality: 80 })
    .toBuffer();
}

/** Requests for one run that arrive while it renders share the render. */
const rendering = new Map<string, Promise<Uint8Array | null>>();

/** Serves from the store, or renders and stores. Null when the run has nothing to render yet. */
export async function runThumbnail(
  store: ObjectStore,
  runId: string,
  review: () => Promise<ReviewRun | null>,
): Promise<Uint8Array | null> {
  try {
    const { body } = await store.get(runThumbnailKey(runId));
    return new Uint8Array(await new Response(body).arrayBuffer());
  } catch (error) {
    if (!(error instanceof ObjectNotFound)) throw error;
  }
  let pending = rendering.get(runId);
  if (!pending) {
    pending = (async () => {
      const run = await review();
      const source = run && thumbnailSource(run);
      if (!source) return null;
      const webp = await renderThumbnail(store, runId, source);
      await store.put(runThumbnailKey(runId), webp, { contentType: "image/webp" });
      return webp;
    })().finally(() => rendering.delete(runId));
    rendering.set(runId, pending);
  }
  return pending;
}
