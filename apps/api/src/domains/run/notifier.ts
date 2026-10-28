/**
 * In-process fan-out to a run's open streams. Two channels, both correct for one API
 * replica only (a second replica would need a shared bus; live frames would reach only the
 * streams on the replica the runner posted to):
 * - `notify`/`watch`: a wake-up after a commit that appends an event or ends the run. It
 *   carries no data: the stream re-reads the log. stream.ts also polls as a backstop.
 * - `publish`/`watchLive`: live frames (`@voluma/contracts/stream`), handed to each open
 *   stream as they arrive. Not stored; a stream that connects later never sees them.
 */
import type { LiveFrame } from "@voluma/contracts/stream";

function registry<T>() {
  const listeners = new Map<string, Set<T>>();
  return {
    add(runId: string, listener: T) {
      const set = listeners.get(runId) ?? new Set();
      set.add(listener);
      listeners.set(runId, set);
      return () => {
        set.delete(listener);
        if (set.size === 0 && listeners.get(runId) === set) listeners.delete(runId);
      };
    },
    of: (runId: string): Iterable<T> => listeners.get(runId) ?? [],
  };
}

export function createNotifier() {
  const wakes = registry<() => void>();
  const frames = registry<(frame: LiveFrame) => void>();
  return {
    /** Call `wake` on each `notify` of the run. Returns the unsubscribe. */
    watch: wakes.add,
    notify(runId: string) {
      for (const wake of wakes.of(runId)) wake();
    },
    /** Call `onFrame` on each `publish` to the run. Returns the unsubscribe. */
    watchLive: frames.add,
    publish(runId: string, frame: LiveFrame) {
      for (const onFrame of frames.of(runId)) onFrame(frame);
    },
  };
}

export type Notifier = ReturnType<typeof createNotifier>;
