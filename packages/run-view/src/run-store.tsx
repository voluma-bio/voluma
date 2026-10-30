/**
 * The run's log for everything below the run page that shows agents: durable events, live frames,
 * the halt and the threads. One store per run page (`RunStoreProvider`), fed by the page's stream
 * and read through selector hooks, so a component re-renders only when what it reads changes: an
 * agent card does not re-render while another thread streams. The store object never changes, so
 * the context that hands it down never re-renders anything.
 *
 * Every derived value is cached by the identity of its inputs and keeps its identity when its
 * inputs change without changing it (`liveOf` for one thread, `threads` while no thread starts or
 * stops writing a tool call), which is what `useSyncExternalStore` compares.
 */
import type { RunEvent } from "@voluma/contracts/events";
import { createContext, type ReactNode, useContext, useState, useSyncExternalStore } from "react";
import { type Thread, withLiveCalls } from "./run-model";
import { type Halt, type Live, mainRows, noLive, type Row, threadRows } from "./transcript";

type RunState = {
  events: RunEvent[];
  live: Live;
  /** The stream is over for good (an ended run's log was sent in full). */
  closed: boolean;
  halt: Halt | undefined;
  /** The threads as the events fold them, before live tool calls are applied. */
  baseThreads: Thread[];
};

const initial: RunState = {
  events: [],
  live: noLive,
  closed: false,
  halt: undefined,
  baseThreads: [],
};

/** The same entries, by identity, in the same order: the earlier map can stand in for the later. */
function sameEntries<V>(a: ReadonlyMap<string, V>, b: ReadonlyMap<string, V>): boolean {
  if (a.size !== b.size) return false;
  const left = a.entries();
  for (const [k, v] of b) {
    const next = left.next().value as [string, V];
    if (next[0] !== k || next[1] !== v) return false;
  }
  return true;
}

export function createRunStore() {
  let state = initial;
  const listeners = new Set<() => void>();

  function set(patch: Partial<RunState>) {
    const next = { ...state, ...patch };
    if ((Object.keys(next) as (keyof RunState)[]).every((k) => next[k] === state[k])) return;
    state = next;
    for (const listener of [...listeners]) listener();
  }

  let threadsMemo: { base: Thread[]; writing: string; threads: Thread[] } | undefined;
  function threads(): Thread[] {
    const writing = [...new Set([...state.live.calls.values()].map((c) => c.threadId))]
      .sort()
      .join();
    if (threadsMemo?.base !== state.baseThreads || threadsMemo.writing !== writing)
      threadsMemo = {
        base: state.baseThreads,
        writing,
        threads: withLiveCalls(state.baseThreads, state.live),
      };
    return threadsMemo.threads;
  }

  // A tool's output frames carry no thread, only the call; the events say whose call it is.
  let callsMemo: { events: RunEvent[]; owner: Map<string, string> } | undefined;
  function callOwner(): Map<string, string> {
    if (callsMemo?.events !== state.events)
      callsMemo = {
        events: state.events,
        owner: new Map(
          state.events.flatMap((e) =>
            e.type === "tool.call" ? [[e.payload.toolCallId, e.threadId] as const] : [],
          ),
        ),
      };
    return callsMemo.owner;
  }

  /** The thread ids whose live frames a thread's transcript shows: all main threads, or itself. */
  function transcriptIds(threadId: string): Set<string> {
    const thread = state.baseThreads.find((t) => t.id === threadId);
    return thread?.kind === "main"
      ? new Set(state.baseThreads.filter((t) => t.kind === "main").map((t) => t.id))
      : new Set([threadId]);
  }

  const liveMemo = new Map<string, Live>();
  /** The live frames of one thread's transcript; the same value while only other threads stream. */
  function liveOf(threadId: string): Live {
    const ids = transcriptIds(threadId);
    const owner = callOwner();
    const next: Live = {
      replies: new Map([...state.live.replies].filter(([, r]) => ids.has(r.threadId))),
      calls: new Map([...state.live.calls].filter(([, c]) => ids.has(c.threadId))),
      outputs: new Map([...state.live.outputs].filter(([call]) => ids.has(owner.get(call) ?? ""))),
    };
    const held = liveMemo.get(threadId);
    if (
      held &&
      sameEntries(held.replies, next.replies) &&
      sameEntries(held.calls, next.calls) &&
      sameEntries(held.outputs, next.outputs)
    )
      return held;
    liveMemo.set(threadId, next);
    return next;
  }

  const rowsMemo = new Map<
    string,
    { events: RunEvent[]; live: Live; halt: Halt | undefined; main: boolean; rows: Row[] }
  >();
  function rowsOf(threadId: string): Row[] {
    const live = liveOf(threadId);
    const main = state.baseThreads.find((t) => t.id === threadId)?.kind === "main";
    const held = rowsMemo.get(threadId);
    if (
      held &&
      held.events === state.events &&
      held.live === live &&
      held.halt === state.halt &&
      held.main === main
    )
      return held.rows;
    const rows = main
      ? mainRows(state.events, live, state.halt)
      : threadRows(state.events, threadId, live, state.halt);
    rowsMemo.set(threadId, { events: state.events, live, halt: state.halt, main, rows });
    return rows;
  }

  return {
    set,
    get: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    threads,
    rowsOf,
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

function useRunSelector<T>(select: (store: RunStore) => T): T {
  const store = useRunStore();
  return useSyncExternalStore(store.subscribe, () => select(store));
}

/** Durable events; the same array while only live frames arrive. */
export const useEvents = () => useRunSelector((s) => s.get().events);
export const useClosed = () => useRunSelector((s) => s.get().closed);
/** Every thread of the run, live tool calls applied (`withLiveCalls`). */
export const useThreads = () => useRunSelector((s) => s.threads());
export const useThread = (threadId: string) =>
  useRunSelector((s) => s.threads().find((t) => t.id === threadId));
/** One thread's transcript rows, rebuilt only when its own events or frames change. */
export const useThreadRows = (threadId: string) => useRunSelector((s) => s.rowsOf(threadId));
