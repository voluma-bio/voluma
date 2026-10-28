/**
 * Open/closed state for agent cards and the running strip, kept per run above the transcript,
 * so a card opened in the main thread is still open after the reader visits a worker and comes
 * back. Ported from Meridian Flow's `subagent/DisclosureStore` (apps/app/src/features/chat).
 */
import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from "react";

type Store = { values: ReadonlyMap<string, boolean>; set: (key: string, value: boolean) => void };
const DisclosureContext = createContext<Store | null>(null);

export function DisclosureProvider({ children }: { children: ReactNode }) {
  const [values, setValues] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  const set = useCallback(
    (key: string, value: boolean) =>
      setValues((current) => {
        if (current.get(key) === value) return current;
        const next = new Map(current);
        next.set(key, value);
        return next;
      }),
    [],
  );
  const store = useMemo(() => ({ values, set }), [values, set]);
  return <DisclosureContext.Provider value={store}>{children}</DisclosureContext.Provider>;
}

export function useDisclosure(key: string): [boolean, (value: boolean) => void] {
  const store = useContext(DisclosureContext);
  const [local, setLocal] = useState(false);
  if (!store) return [local, setLocal];
  return [store.values.get(key) ?? false, (value) => store.set(key, value)];
}
