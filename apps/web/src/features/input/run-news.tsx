/**
 * The top of Final outputs while an agent-loop run goes: that it is going, how long since the log
 * last grew ("last news 12 min ago", from the newest stored event), and what the AI is doing now
 * (the latest `activity` event's sentence; each replaces the last, and whichever AI wrote it stays
 * unnamed here). Gone once the run ends. Design: the agent-model `review.md`, "the page during a
 * run is variant B plus an activity line".
 */
import type { RunEvent } from "@voluma/contracts/events";
import type { RunState } from "@voluma/contracts/run";
import { useNow, whenText } from "@voluma/run-view";
import { StatusMark } from "@voluma/ui";
import { useMemo } from "react";

/** The latest `activity` sentence, else none. */
function activityOf(events: readonly RunEvent[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type === "activity") return e.payload.text;
  }
  return undefined;
}

export function RunNews({ events, state }: { events: readonly RunEvent[]; state: RunState }) {
  // Queued or held for keys: not running yet.
  const waiting = state.status === "queued" || state.status === "awaiting-keys";
  const last = events.at(-1)?.createdAt;
  const activity = useMemo(() => activityOf(events), [events]);
  return (
    <div className="grid gap-1 border-b border-border px-3 py-2.5">
      <p className="m-0 flex items-baseline gap-2">
        <StatusMark
          status={waiting ? "waiting" : "running"}
          label={waiting ? "Waiting" : "Running"}
          className="font-medium"
        />
        {last && <LastNews at={last} />}
      </p>
      {activity && (
        <p aria-live="polite" className="m-0 pl-5 text-sm">
          {activity}
        </p>
      )}
    </div>
  );
}

/** "last news 12 min ago", on its own clock so only it re-renders each second. */
function LastNews({ at }: { at: string }) {
  const now = useNow(true);
  return <span className="text-muted-foreground text-xs">last news {whenText(at, now)}</span>;
}
