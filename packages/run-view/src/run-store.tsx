/**
 * The run's durable events for everything below the run page that reads them. One store per run
 * page (`RunStoreProvider`), fed by the page's stream and read through `useEvents`, so a component
 * re-renders only when the events change. The store object never changes, so the context that
 * hands it down never re-renders anything.
 */
import type { RunEvent } from "@voluma/contracts/events";
import { createContext, type ReactNode, useContext, useState, useSyncExternalStore } from "react";

export function createRunStore() {
  let events: RunEvent[] = [];
  const listeners = new Set<() => void>();
  return {
    set(next: RunEvent[]) {
      if (next === events) return;
      events = next;
      for (const listener of [...listeners]) listener();
    },
    get: () => events,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}
export type RunStore = ReturnType<typeof createRunStore>;

const RunStoreContext = createContext<RunStore | null>(null);

/** One store per run page: mount it keyed on the run. */
export function RunStoreProvider({ children }: { children: ReactNode }) {
  const [store] = useState(createRunStore);
  return <RunStoreContext.Provider value={store}>{children}</RunStoreContext.Provider>;
}

export function useRunStore(): RunStore {
  const store = useContext(RunStoreContext);
  if (!store) throw new Error("the run store hooks need a RunStoreProvider above them");
  return store;
}

/** The run's durable events, in log order. */
export function useEvents(): RunEvent[] {
  const store = useRunStore();
  return useSyncExternalStore(store.subscribe, store.get);
}
