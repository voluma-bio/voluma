/** The main thread's side of the zarr worker: one worker for every pane, promises per request. */

import type { Axis } from "./scene";
import type { PlaneRequest, PlaneResponse, Values } from "./zarr.worker";

export type Plane = { data: Values; rows: number; cols: number; shape: number[] };

let worker: Worker | undefined;
let nextId = 1;
const pending = new Map<number, { resolve(plane: Plane): void; reject(error: Error): void }>();

function post(request: PlaneRequest) {
  if (!worker) {
    worker = new Worker(new URL("./zarr.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = ({ data }: MessageEvent<PlaneResponse>) => {
      const waiter = pending.get(data.id);
      pending.delete(data.id);
      if (!waiter) return;
      if ("error" in data) waiter.reject(new Error(data.error));
      else waiter.resolve(data);
    };
    // A worker that fails to load or dies answers nothing: fail every request, start afresh next time.
    worker.onerror = (event) => {
      event.preventDefault();
      const error = new Error(event.message || "The image reader stopped.");
      for (const waiter of pending.values()) waiter.reject(error);
      pending.clear();
      worker?.terminate();
      worker = undefined;
    };
  }
  worker.postMessage(request);
}

function request(
  body: { base: string; path: string } & Record<string, unknown>,
  signal: AbortSignal,
) {
  const id = nextId++;
  return new Promise<Plane>((resolve, reject) => {
    const abort = () => {
      // Only a request still waiting is cancelled; a settled one is already gone from the worker.
      if (!pending.delete(id)) return;
      post({ cancel: id });
      reject(signal.reason);
    };
    const settle = () => signal.removeEventListener("abort", abort);
    pending.set(id, {
      resolve(plane) {
        settle();
        resolve(plane);
      },
      reject(error) {
        settle();
        reject(error);
      },
    });
    post({ id, ...body } as PlaneRequest);
    signal.addEventListener("abort", abort, { once: true });
  });
}

/** One plane through a level, `axis` held at `index` (level voxels). */
export const readPlane = (
  base: string,
  path: string,
  axis: Axis,
  index: number,
  signal: AbortSignal,
) => request({ base, path, axis, index }, signal);

/** A whole level; meant for the coarsest, which is one or a few chunks. */
export const readLevel = (base: string, path: string, signal: AbortSignal) =>
  request({ base, path, whole: true }, signal);

/**
 * A whole level, shared: the 3D pane, the contrast and tilted slices read the same copy. The last
 * few levels asked for are kept; a caller that stops waiting doesn't cancel the read.
 */
export function sharedLevel(base: string, path: string): Promise<Plane> {
  const key = `${base}${path}`;
  const had = levels.get(key);
  if (had) {
    levels.delete(key);
    levels.set(key, had);
    return had;
  }
  const read = request({ base, path, whole: true }, new AbortController().signal);
  read.catch(() => levels.delete(key));
  levels.set(key, read);
  while (levels.size > KEPT_LEVELS) levels.delete(levels.keys().next().value!);
  return read;
}
/** Two grids' coarsest and 3D levels. */
const KEPT_LEVELS = 4;
const levels = new Map<string, Promise<Plane>>();
