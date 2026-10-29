/**
 * Reads OME-Zarr levels off the main thread: one plane through a level for a slice pane, or a
 * whole (coarse) level. Decoded chunks are kept in one bounded cache shared by every array, so
 * scrolling within a chunk's 64 planes and crossing panes reuse them. Fetches wait for one of a
 * few slots, newest request first; a chunk that every request asking for it has cancelled by the
 * time its slot comes is never fetched. A chunk already fetching finishes into the cache.
 */
import * as zarr from "zarrita";
import type { Axis } from "./scene";
import { planeAxes } from "./scene";

export type PlaneRequest =
  | { id: number; base: string; path: string; axis: Axis; index: number }
  | { id: number; base: string; path: string; whole: true }
  | { cancel: number };
export type Values = Int16Array | Uint16Array | Uint8Array | Int8Array | Float32Array | Int32Array;
export type PlaneResponse =
  | { id: number; data: Values; rows: number; cols: number; shape: number[] }
  | { id: number; error: string };

type Chunk = { data: Values; stride: number[] };
const CACHE_BYTES = 384 * 1024 ** 2;
const MAX_FETCHES = 12;

const arrays = new Map<string, Promise<zarr.Array<zarr.DataType, zarr.Readable>>>();
const chunks = new Map<string, Chunk>();
const loading = new Map<string, { promise: Promise<Chunk>; wanted: Set<number> }>();
const cancelled = new Set<number>();
let cachedBytes = 0;
let active = 0;
const waiting: (() => void)[] = [];

function open(base: string, path: string) {
  const key = base + path;
  let array = arrays.get(key);
  if (!array) {
    array = zarr.open.v2(zarr.root(new zarr.FetchStore(base)).resolve(path), { kind: "array" });
    arrays.set(key, array);
    array.catch(() => arrays.delete(key));
  }
  return array;
}

class Cancelled extends Error {}

async function slot<T>(wanted: () => boolean, work: () => Promise<T>): Promise<T> {
  if (active >= MAX_FETCHES) await new Promise<void>((go) => waiting.push(go));
  if (!wanted()) {
    waiting.pop()?.();
    throw new Cancelled();
  }
  active++;
  try {
    return await work();
  } finally {
    active--;
    waiting.pop()?.();
  }
}

function chunk(
  request: number,
  key: string,
  array: zarr.Array<zarr.DataType, zarr.Readable>,
  coords: number[],
): Promise<Chunk> {
  const id = `${key}|${coords.join(".")}`;
  const hit = chunks.get(id);
  if (hit) {
    // Re-insert: Map order is the eviction order.
    chunks.delete(id);
    chunks.set(id, hit);
    return Promise.resolve(hit);
  }
  const pending = loading.get(id);
  if (pending) {
    pending.wanted.add(request);
    return pending.promise;
  }
  const wanted = new Set([request]);
  const promise = slot(
    () => [...wanted].some((r) => !cancelled.has(r)),
    () => array.getChunk(coords),
  ).then((c) => {
    const value = { data: c.data as Values, stride: c.stride };
    chunks.set(id, value);
    cachedBytes += value.data.byteLength;
    for (const [old, { data }] of chunks) {
      if (cachedBytes <= CACHE_BYTES) break;
      chunks.delete(old);
      cachedBytes -= data.byteLength;
    }
    return value;
  });
  loading.set(id, { promise, wanted });
  void promise.finally(() => loading.delete(id)).catch(() => {});
  return promise;
}

async function plane(id: number, base: string, path: string, axis: Axis, index: number) {
  const array = await open(base, path);
  const shape = array.shape;
  const size = array.chunks;
  const [ra, ca] = planeAxes(axis);
  const rows = shape[ra]!;
  const cols = shape[ca]!;
  if (index < 0 || index >= shape[axis]!) throw new Error("Slice is outside the volume.");
  const along = Math.floor(index / size[axis]!);
  const local = index - along * size[axis]!;
  let out: Values | undefined;
  const work: Promise<void>[] = [];
  for (let cr = 0; cr < Math.ceil(rows / size[ra]!); cr++)
    for (let cc = 0; cc < Math.ceil(cols / size[ca]!); cc++) {
      const coords = [0, 0, 0];
      coords[axis] = along;
      coords[ra] = cr;
      coords[ca] = cc;
      work.push(
        (async () => {
          if (cancelled.has(id)) return;
          const { data, stride } = await chunk(id, base + path, array, coords);
          if (cancelled.has(id)) return;
          out ??= new (data.constructor as new (n: number) => Values)(rows * cols);
          const r0 = cr * size[ra]!;
          const c0 = cc * size[ca]!;
          const rn = Math.min(size[ra]!, rows - r0);
          const cn = Math.min(size[ca]!, cols - c0);
          const sr = stride[ra]!;
          const sc = stride[ca]!;
          for (let r = 0; r < rn; r++) {
            const from = local * stride[axis]! + r * sr;
            const to = (r0 + r) * cols + c0;
            for (let c = 0; c < cn; c++) out[to + c] = data[from + c * sc]!;
          }
        })(),
      );
    }
  await Promise.all(work);
  return out && { data: out, rows, cols, shape: [...shape] };
}

async function whole(base: string, path: string) {
  const array = await open(base, path);
  const { data, shape } = await zarr.get(array);
  return { data: data as Values, rows: shape[1]!, cols: shape[2]!, shape };
}

self.onmessage = async ({ data: request }: MessageEvent<PlaneRequest>) => {
  if ("cancel" in request) {
    cancelled.add(request.cancel);
    return;
  }
  const { id } = request;
  try {
    const result =
      "whole" in request
        ? await whole(request.base, request.path)
        : await plane(id, request.base, request.path, request.axis, request.index);
    if (!result || cancelled.has(id)) return;
    postMessage({ id, ...result } satisfies PlaneResponse, { transfer: [result.data.buffer] });
  } catch (cause) {
    if (cause instanceof Cancelled || cancelled.has(id)) return;
    postMessage({
      id,
      error: cause instanceof Error ? cause.message : String(cause),
    } satisfies PlaneResponse);
  } finally {
    cancelled.delete(id);
  }
};
