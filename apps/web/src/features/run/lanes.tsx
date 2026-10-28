/** The threads working right now, side by side: each lane shows its newest tool calls as they happen and opens its full stream. */
import { useEffect, useState } from "react";
import { Link } from "react-router";
import { threadHref } from "./feed";
import { threadRole } from "./parts";
import type { Thread } from "./run-feed";
import { taskTitle } from "./workflows";

function elapsed(from: string, now: number): string {
  const s = Math.max(0, Math.floor((now - new Date(from).getTime()) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

export function Lanes({
  threads,
  openThread,
  hover,
}: {
  threads: Thread[];
  openThread: string | null;
  hover: string | null;
}) {
  const now = useNow(threads.length > 0);
  if (threads.length === 0) return null;
  return (
    <section aria-label="Working now">
      <h2 className="mb-2 flex items-baseline gap-3 text-ui font-medium">
        Working now
        <span className="font-normal text-muted-foreground">
          {threads.length} {threads.length === 1 ? "thread" : "threads at once"}
        </span>
      </h2>
      <ul className="grid grid-cols-[repeat(auto-fit,minmax(17rem,1fr))] gap-3">
        {threads.map((t) => (
          <li key={t.id} className="min-w-0">
            <Link
              to={threadHref(t.id)}
              aria-current={t.id === openThread ? "true" : undefined}
              className={`block h-full rounded-xl border border-info/40 bg-card p-3 shadow-sm transition-opacity hover:border-info aria-[current]:ring-2 aria-[current]:ring-primary ${
                hover !== null && hover !== t.taskId ? "opacity-40" : ""
              }`}
            >
              <div className="flex items-center gap-2">
                <span
                  className="size-2 shrink-0 animate-pulse rounded-full bg-info motion-reduce:animate-none"
                  aria-hidden="true"
                />
                <span className="min-w-0 flex-1 truncate font-medium">
                  {t.taskId ? taskTitle(t.taskId) : threadRole(t)}
                </span>
                <span className="text-meta text-muted-foreground tabular-nums">
                  {elapsed(t.startedAt, now)}
                </span>
              </div>
              <p className="mt-0.5 text-meta text-muted-foreground">
                {threadRole(t)}
                {t.model && <span className="font-mono">, {t.model}</span>}
                {`, ${t.toolCalls} ${t.toolCalls === 1 ? "call" : "calls"}`}
              </p>
              <ul className="mt-2 grid gap-1 rounded-md bg-muted p-2 font-mono text-meta">
                {t.recent.length === 0 && (
                  <li className="truncate text-muted-foreground">{t.said ?? "Starting…"}</li>
                )}
                {t.recent.map((c) => (
                  <li
                    key={c.callId}
                    className={`truncate ${c.failed ? "text-destructive" : c.running ? "text-foreground" : "text-muted-foreground"}`}
                  >
                    {c.running ? "▸ " : c.failed ? "✕ " : "✓ "}
                    {c.text}
                  </li>
                ))}
              </ul>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
