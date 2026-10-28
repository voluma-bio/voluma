/**
 * In-process wake-ups for a run's open streams: `notify` after a commit that appends an
 * event or ends the run, `watch` to hear it. A wake-up carries no data: the stream re-reads
 * the log. Correct for one API replica; stream.ts also polls as a backstop.
 */
export function createNotifier() {
  const listeners = new Map<string, Set<() => void>>();
  return {
    /** Call `wake` on each `notify` of the run. Returns the unsubscribe. */
    watch(runId: string, wake: () => void) {
      const set = listeners.get(runId) ?? new Set();
      set.add(wake);
      listeners.set(runId, set);
      return () => {
        set.delete(wake);
        if (set.size === 0 && listeners.get(runId) === set) listeners.delete(runId);
      };
    },
    notify(runId: string) {
      for (const wake of listeners.get(runId) ?? []) wake();
    },
  };
}

export type Notifier = ReturnType<typeof createNotifier>;
