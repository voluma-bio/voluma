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
  }
  worker.postMessage(request);
}

function request(
  body: { base: string; path: string } & Record<string, unknown>,
  signal: AbortSignal,
) {
  const id = nextId++;
  return new Promise<Plane>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    post({ id, ...body } as PlaneRequest);
    signal.addEventListener("abort", () => {
      pending.delete(id);
      post({ cancel: id });
      reject(signal.reason);
    });
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
