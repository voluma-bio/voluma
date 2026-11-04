/**
 * One agent's thread in its own scroll: rows derived for this thread only (`threadRows`),
 * memoized on the run's events, and a scroll that follows the newest line while the reader is at
 * the bottom. It fills the box its caller gives it. Mount it keyed on the
 * agent, so picking another starts at its own end. A screen puts its own rows in by log position
 * (`slots`, rendered by `slot`). Main's Conversation (`conversation`) drops the divider between
 * `main.N` and says its newest status line in the live line, not the running call.
 */
import type { RunEvent } from "@voluma/contracts/events";
import { type ReactNode, useLayoutEffect, useMemo, useRef } from "react";
import { latestActivity, runningTitle, type Slot, threadRows } from "./transcript";
import { type AgentLinks, TranscriptView } from "./transcript-view";

/** How close to the bottom still counts as "at the bottom", in px. */
const STICK = 48;

export function AgentThread({
  events,
  ids,
  working,
  live,
  links,
  slots,
  slot,
  nameOf,
  conversation = false,
  waiting,
  opensAtEnd = false,
  empty,
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
  /** The screen's own rows, by log position. Keep it stable between renders. */
  slots?: readonly Slot[];
  slot?: (id: string) => ReactNode;
  /** An output's catalog name, for the reports in the thread. Keep it stable between renders. */
  nameOf?: (id: string) => string;
  /** The thread is main's Conversation (see the header). */
  conversation?: boolean;
  /** Nothing works yet, and why ("Waiting to start · place 2 in line"): a quiet live line. */
  waiting?: string;
  /** Open an ended thread at its newest line, as a conversation does, not at the top. */
  opensAtEnd?: boolean;
  /** What an empty thread says, when not the default. */
  empty?: string;
  className?: string;
}) {
  const key = ids.join(" ");
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` is `ids`' content
  const rows = useMemo(
    () => threadRows(events, ids, live, { slots, nameOf, conversation }),
    [events, key, live, slots, nameOf, conversation],
  );

  // A thread of a live run opens at its newest line and follows it while the reader is at the
  // bottom; an ended one opens at the top. Whether they were at the bottom is read during render,
  // before this update reaches the DOM, so a fold they opened since the last event (which grew
  // the content) does not count as them being left behind, and scrolling up stops following.
  const viewport = useRef<HTMLDivElement>(null);
  const wasAtBottom = useRef(live || opensAtEnd);
  const el0 = viewport.current;
  if (el0) wasAtBottom.current = el0.scrollHeight - el0.scrollTop - el0.clientHeight < STICK;
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the rows or the live line change
  useLayoutEffect(() => {
    const el = viewport.current;
    if (el && wasAtBottom.current && rows.length > 0) el.scrollTop = el.scrollHeight;
  }, [rows, working, waiting]);

  return (
    <div
      ref={viewport}
      role="log"
      className={`min-h-0 overflow-y-auto overscroll-contain ${className}`}
    >
      <TranscriptView
        rows={rows}
        links={links}
        slot={slot}
        live={
          waiting
            ? { text: waiting, words: true, quiet: true }
            : !working
              ? null
              : conversation
                ? { text: latestActivity(rows) ?? "Working", words: true }
                : { text: runningTitle(rows) ?? "" }
        }
        empty={empty ?? (working ? "Nothing yet." : "It wrote nothing.")}
      />
    </div>
  );
}
