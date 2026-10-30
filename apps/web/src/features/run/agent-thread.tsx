/**
 * One agent's thread, anywhere: `<AgentThread threadId>` reads the run's stream from
 * `RunLogProvider` (one per run page), builds that agent's rows, and owns its header, its live
 * line and its own scroll, which sticks to the newest line while the reader is at the bottom.
 * It fills the box its caller gives it, so moving a thread to another place is one line.
 * Shape from Meridian Flow's `ChatView` (the caller names a thread; the container reads it).
 */
import type { RunEvent } from "@voluma/contracts/events";
import { catalog } from "@voluma/workflow/bundled";
import { createContext, type ReactNode, useContext, useLayoutEffect, useMemo, useRef } from "react";
import { Elapsed, STATUS_WORD, ThreadSpendInfo } from "./agents";
import { agentLabel, type Thread } from "./run-model";
import { type Halt, type Live, mainRows, threadRows } from "./transcript";
import { TranscriptView } from "./transcript-view";

const { taskTitle } = catalog["mouse-oa"];

type RunLog = {
  events: RunEvent[];
  live: Live;
  halt: Halt | undefined;
  /** Every thread of the run, live tool calls applied (`withLiveCalls`). */
  threads: Thread[];
};

const RunLogContext = createContext<RunLog | null>(null);

export const RunLogProvider = RunLogContext.Provider;

export function useRunLog(): RunLog {
  const stream = useContext(RunLogContext);
  if (!stream) throw new Error("AgentThread needs a RunLogProvider");
  return stream;
}

/** "Segmentation: Second AI check of try 2", "Lead AI". */
export const agentTitle = (t: Thread, threads: Thread[]) =>
  t.taskId ? `${taskTitle(t.taskId)}: ${agentLabel(t, threads)}` : agentLabel(t, threads);

/** How close to the bottom still counts as "at the bottom", in px. */
const STICK = 48;

export function AgentThread({
  threadId,
  actions,
  className = "",
}: {
  threadId: string;
  /** Controls the host adds to the header's right end (e.g. Follow live). */
  actions?: ReactNode;
  className?: string;
}) {
  const { events, live, halt, threads } = useRunLog();
  const thread = threads.find((t) => t.id === threadId);
  const kind = thread?.kind;
  const rows = useMemo(
    () =>
      kind === "main" ? mainRows(events, live, halt) : threadRows(events, threadId, live, halt),
    [kind, threadId, events, live, halt],
  );
  const threadById = useMemo(() => new Map(threads.map((t) => [t.id, t])), [threads]);
  const running = thread?.status === "running";

  // Its own scroll: a running thread opens at its newest line and stays there while the reader
  // is at the bottom; scrolling up stops it until they scroll back down.
  const viewport = useRef<HTMLDivElement>(null);
  const stuck = useRef(running);
  useLayoutEffect(() => {
    const el = viewport.current;
    if (el && stuck.current && rows.length > 0) el.scrollTop = el.scrollHeight;
  }, [rows]);

  if (!thread) return null;
  // Its latest milestone or result; what it is running now is the stream's last line.
  const answer = running ? thread.result?.text : (thread.error ?? thread.result?.text);
  return (
    <section className={`flex min-h-0 min-w-0 flex-col ${className}`}>
      <header className="grid shrink-0 gap-1 border-b border-border pb-3">
        <div className="flex min-w-0 items-center gap-2">
          <h2 className="min-w-0 truncate text-lg font-semibold">{agentTitle(thread, threads)}</h2>
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
          const el = e.currentTarget;
          stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK;
        }}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain pt-4 pr-2"
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
