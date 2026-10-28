/** Small pieces the feed and the thread view share: clock times, collapsing long text, thread labels. */
import { useState } from "react";
import type { Thread } from "./run-feed";
import { taskTitle } from "./workflows";

/** A duration as the reader says it: "45 s", "4 min", "2 h 5 min". */
export function elapsed(from: string, now: number): string {
  const s = Math.max(0, Math.floor((now - new Date(from).getTime()) / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

const LINES = 6;
const CHARS = 500;

/** Text that collapses past a few lines, with an expand. `mono` is for command output. */
export function Clamp({ text, mono, tone }: { text: string; mono?: boolean; tone?: "error" }) {
  const [open, setOpen] = useState(false);
  const long = text.length > CHARS || text.split("\n").length > LINES;
  return (
    <div>
      <pre
        className={`whitespace-pre-wrap break-words rounded-md px-3 py-2 text-meta ${
          mono ? "font-mono" : "font-sans"
        } ${tone === "error" ? "bg-destructive-tint text-destructive" : "bg-muted text-foreground"} ${
          long && !open ? "max-h-40 overflow-hidden" : ""
        }`}
      >
        {text}
      </pre>
      {long && (
        <button
          type="button"
          onClick={() => setOpen(!open)}
          className="mt-1 text-meta text-primary-text hover:underline"
        >
          {open ? "Show less" : `Show all (${text.length.toLocaleString()} characters)`}
        </button>
      )}
    </div>
  );
}

export const threadRole = (t: Pick<Thread, "kind">) =>
  t.kind === "worker"
    ? "Worker"
    : t.kind === "check"
      ? "Checker"
      : t.kind === "supervisor"
        ? "Main thread"
        : "Chat";

export const threadName = (t: Pick<Thread, "kind" | "taskId">) =>
  t.taskId ? `${threadRole(t)}: ${taskTitle(t.taskId)}` : threadRole(t);
