/**
 * The one way to open a thread: agent card names in the lead AI's stream and the Agents tree call
 * the same `openThread`, so there is one router and several doors onto it. Ported from
 * Meridian Flow's `ChatThreadNavigation` (apps/app/src/features/chat). Rows expand, names navigate.
 */
import { createContext, type ReactNode, useContext } from "react";

type OpenThread = (threadId: string | null) => void;

const ThreadNavigationContext = createContext<OpenThread>(() => {});

export function ThreadNavigationProvider({
  onOpenThread,
  children,
}: {
  onOpenThread: OpenThread;
  children: ReactNode;
}) {
  return (
    <ThreadNavigationContext.Provider value={onOpenThread}>
      {children}
    </ThreadNavigationContext.Provider>
  );
}

export const useOpenThread = (): OpenThread => useContext(ThreadNavigationContext);
