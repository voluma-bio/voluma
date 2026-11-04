/**
 * One agent's thread in its own scroll: rows derived for this thread only (`threadRows`),
 * memoized on the run's events, and a scroll that sticks to the newest line while the agent works
 * and the reader is at the bottom. It fills the box its caller gives it. Mount it keyed on the
 * agent, so picking another starts at its own end.
 */
import type { RunEvent } from "@voluma/contracts/events";
import { useLayoutEffect, useMemo, useRef } from "react";
import { runningTitle, threadRows } from "./transcript";
import { type AgentLinks, TranscriptView } from "./transcript-view";

/** How close to the bottom still counts as "at the bottom", in px. */
const STICK = 48;

export function AgentThread({
  events,
  ids,
  working,
  live,
  links,
  className = "",
}: {
  events: readonly RunEvent[];
  /** The thread ids to show, in log order. */
  ids: readonly string[];
  /** The agent is at work: the thread ends in a live line, and follows its newest row. */
  working: boolean;
  /** The run has not ended: a call without a result is running, else it was stopped. */
  live: boolean;
  links?: AgentLinks;
  className?: string;
}) {
  const key = ids.join(" ");
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` is `ids`' content
  const rows = useMemo(() => threadRows(events, ids, live), [events, key, live]);

  // A working thread opens at its newest line and stays there while the reader is at the bottom;
  // scrolling up stops it until they scroll back down.
  const viewport = useRef<HTMLDivElement>(null);
  const stuck = useRef(working);
  const lastTop = useRef<number | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the rows change
  useLayoutEffect(() => {
    const el = viewport.current;
    if (!el) return;
    // A thread that fits already starts at the bottom, even without a scroll event.
    if (lastTop.current === null && el.scrollHeight - el.clientHeight < STICK) stuck.current = true;
    if (stuck.current && rows.length > 0) el.scrollTop = el.scrollHeight;
    lastTop.current = el.scrollTop;
  }, [rows]);

  return (
    <div
      ref={viewport}
      role="log"
      onScroll={(e) => {
        // Any move up lets go, however small (a trackpad's first events stay near the bottom);
        // only coming back down to the bottom sticks again.
        const el = e.currentTarget;
        // Layout already accounted for this position; its queued event must not re-enable follow.
        if (el.scrollTop === lastTop.current) return;
        if (lastTop.current !== null && el.scrollTop < lastTop.current) stuck.current = false;
        else if (el.scrollHeight - el.scrollTop - el.clientHeight < STICK) stuck.current = true;
        lastTop.current = el.scrollTop;
      }}
      className={`min-h-0 overflow-y-auto overscroll-contain ${className}`}
    >
      <TranscriptView
        rows={rows}
        links={links}
        live={working ? (runningTitle(rows) ?? "") : null}
        empty={working ? "Nothing yet." : "It wrote nothing."}
      />
    </div>
  );
}
