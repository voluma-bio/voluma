/**
 * One agent's thread, anywhere: `<AgentThread threadId>` reads its rows from the run
 * store (`run-store.tsx`, one per run page), and owns its header, its live
 * line and its own scroll, which sticks to the newest line while the reader is at the bottom.
 * It fills the box its caller gives it, so moving a thread to another place is one line.
 * Shape from Meridian Flow's `ChatView` (the caller names a thread; the container reads it).
 */
import { type ReactNode, useLayoutEffect, useMemo, useRef } from "react";
import { Elapsed, STATUS_WORD, ThreadSpendInfo } from "./agents";
import { agentLabel, agentTitle } from "./run-model";
import { useThread, useThreadRows, useThreads } from "./run-store";
import { TranscriptView } from "./transcript-view";

/** How close to the bottom still counts as "at the bottom", in px. */
const STICK = 48;

export function AgentThread({
  threadId,
  actions,
  inTask = false,
  className = "",
}: {
  threadId: string;
  /** Shown under its task's heading: a smaller title without the task's name. */
  inTask?: boolean;
  /** Controls the host adds to the header's right end (e.g. Follow live). */
  actions?: ReactNode;
  className?: string;
}) {
  const threads = useThreads();
  const thread = useThread(threadId);
  const kind = thread?.kind;
  const rows = useThreadRows(threadId);
  const threadById = useMemo(() => new Map(threads.map((t) => [t.id, t])), [threads]);
  const running = thread?.status === "running";

  // Its own scroll: a running thread opens at its newest line and stays there while the reader
  // is at the bottom; scrolling up stops it until they scroll back down.
  const viewport = useRef<HTMLDivElement>(null);
  const stuck = useRef(running);
  const lastTop = useRef<number | null>(null);
  useLayoutEffect(() => {
    const el = viewport.current;
    if (!el) return;
    // A paused thread that fits already starts at the bottom, even without a scroll event.
    if (lastTop.current === null && el.scrollHeight - el.clientHeight < STICK) stuck.current = true;
    if (stuck.current && rows.length > 0) el.scrollTop = el.scrollHeight;
    // Settling a reply removes its caret and can clamp scrollTop down. That is not reader input.
    lastTop.current = el.scrollTop;
  }, [rows]);

  if (!thread) return null;
  // Its latest milestone or result; what it is running now is the stream's last line.
  const answer = running ? thread.result?.text : (thread.error ?? thread.result?.text);
  return (
    <section className={`flex min-h-0 min-w-0 flex-col ${className}`}>
      <header className="grid shrink-0 gap-1 border-b border-border pb-3">
        <div className="flex min-w-0 items-center gap-2">
          {inTask ? (
            <h3 className="min-w-0 truncate text-ui font-medium">{agentLabel(thread, threads)}</h3>
          ) : (
            <h2 className="min-w-0 truncate text-lg font-semibold">
              {agentTitle(thread, threads)}
            </h2>
          )}
          <span className="shrink-0 text-meta text-muted-foreground">
            {STATUS_WORD[thread.status]}
          </span>
          <Elapsed thread={thread} />
          <ThreadSpendInfo thread={thread} />
          {actions && <div className="ml-auto flex shrink-0 items-center">{actions}</div>}
        </div>
        {answer && <p className="truncate text-meta text-muted-foreground">{answer}</p>}
      </header>
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
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain pt-4 pr-2 min-[1100px]:pl-8"
      >
        <TranscriptView
          rows={rows}
          threads={kind === "main" ? threadById : undefined}
          live={running ? (thread.liveTool ?? "") : null}
          empty={
            running
              ? "Nothing yet."
              : thread.status === "paused" ||
                  thread.status === "awaiting-ai" ||
                  thread.status === "cancelled"
                ? "It was cut off before it wrote anything."
                : "It wrote nothing."
          }
        />
      </div>
    </section>
  );
}
