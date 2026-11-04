/** The main thread's side of the zarr worker: one worker for every pane, promises per request. */

import type { LevelSampling } from "./reslice";
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

/**
 * A tilted plane's samples on a level (`reslice.ts`), as float32: trilinear (NaN off the level),
 * or `nearest` (0 off it). Only the chunks the samples cross are read.
 */
export const readSlice = (
  base: string,
  path: string,
  reslice: LevelSampling,
  nearest: boolean,
  signal: AbortSignal,
) => request({ base, path, reslice, nearest }, signal);

/** A whole level; meant for the coarsest, which is one or a few chunks. */
export const readLevel = (base: string, path: string, signal: AbortSignal) =>
  request({ base, path, whole: true }, signal);

/**
 * A whole level, shared while held: the 3D pane, the contrast and tilted slices read one copy.
 * Each mounted user holds it and releases it on unmount; the last release drops the level (and
 * cancels its read if still waiting). The drop waits a microtask, so an effect that re-runs
 * (release, then hold again) keeps the level instead of reading it again.
 */
export function holdLevel(base: string, path: string): { read: Promise<Plane>; release(): void } {
  const key = `${base}${path}`;
  let held = levels.get(key);
  if (!held) {
    const abort = new AbortController();
    const entry: Held = {
      read: request({ base, path, whole: true }, abort.signal),
      users: 0,
      abort,
    };
    // A failed read isn't kept, so the next user tries again.
    entry.read.catch(() => {
      if (levels.get(key) === entry) levels.delete(key);
    });
    levels.set(key, entry);
    held = entry;
  }
  const entry = held;
  entry.users++;
  let released = false;
  return {
    read: entry.read,
    release() {
      if (released) return;
      released = true;
      entry.users--;
      queueMicrotask(() => {
        if (entry.users > 0 || levels.get(key) !== entry) return;
        levels.delete(key);
        entry.abort.abort();
      });
    },
  };
}
type Held = { read: Promise<Plane>; users: number; abort: AbortController };
const levels = new Map<string, Held>();
