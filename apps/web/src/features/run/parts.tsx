/** Small pieces the feed and the thread view share: clock times, collapsing long text, thread labels. */
import { useState } from "react";
import type { Thread } from "./run-feed";
import { taskTitle } from "./workflows";

export const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

const LINES = 10;
const CHARS = 800;

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
