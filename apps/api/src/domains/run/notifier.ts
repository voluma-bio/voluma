/**
 * In-process wake-up of a run's open streams, correct for one API replica only (a second
 * replica would need a shared bus): `notify`/`watch` fire after a commit that appends an event
 * or ends the run. They carry no data: the stream re-reads the log. stream.ts also polls as a
 * backstop.
 */

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
  return {
    /** Call `wake` on each `notify` of the run. Returns the unsubscribe. */
    watch: wakes.add,
    notify(runId: string) {
      for (const wake of wakes.of(runId)) wake();
    },
  };
}

export type Notifier = ReturnType<typeof createNotifier>;
