/** A run's time so far, and a ticking clock. The status chip and the formatters are `@voluma/ui/run`. */
import type { Run } from "@voluma/contracts/run";
import { useEffect, useState } from "react";

/** The time now, ticking each second while `active`. */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

/** From the first claim to the end, or to now while it runs; null while it waits (queued, or for keys). */
export function runSeconds({ state }: Run, now = Date.now()): number | null {
  if (state.status === "queued" || state.status === "awaiting-keys" || !state.startedAt)
    return null;
  const end = state.status === "ended" ? Date.parse(state.endedAt) : now;
  return (end - Date.parse(state.startedAt)) / 1000;
}
