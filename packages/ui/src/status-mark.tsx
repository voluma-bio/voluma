/**
 * Status mark: one glyph and one word per state, for a task, scan, item, run or agent, wherever it
 * appears. This is the one list of states and their words; features map their own statuses (task,
 * run, agent thread) onto it. The glyph's shape carries the state without colour: a diamond to
 * check, a tick done, a turning arc running, a turning arc round a tick checking (a second AI
 * checks the work), a dashed ring waiting, bars paused, a crossed square stopped. A caller may
 * replace the word with a more exact one that keeps the state's meaning ("2 to check", "Failed").
 */
import type { ReactNode } from "react";
import { cx } from "./cx";

export type Status = "check" | "running" | "checking" | "done" | "waiting" | "paused" | "stopped";

export const STATUS_WORD: Record<Status, string> = {
  check: "To check",
  running: "Running",
  checking: "Checking",
  done: "Done",
  waiting: "Waiting",
  paused: "Paused",
  stopped: "Stopped",
};

const ink: Record<Status, string> = {
  check: "text-check",
  running: "text-info",
  checking: "text-info",
  done: "text-done",
  waiting: "text-fg-subtle",
  paused: "text-fg-subtle",
  stopped: "text-destructive",
};

const solid: Record<Status, string> = {
  check: "text-check-solid",
  running: "text-info-solid",
  checking: "text-info-solid",
  done: "text-done-solid",
  waiting: "text-idle",
  paused: "text-idle",
  stopped: "text-destructive-solid",
};

export type StatusMarkProps = {
  status: Status;
  /** Replaces the state's word, e.g. "2 to check" or "Failed". */
  label?: ReactNode;
  className?: string;
};

export function StatusMark({ status, label, className }: StatusMarkProps) {
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1.5 text-sm whitespace-nowrap",
        ink[status],
        className,
      )}
    >
      <StatusGlyph status={status} />
      {label ?? STATUS_WORD[status]}
    </span>
  );
}

/** The glyph alone, 14 px, for dense places that name the state another way. */
export function StatusGlyph({ status, className }: { status: Status; className?: string }) {
  return (
    <svg
      viewBox="0 0 14 14"
      aria-hidden
      className={cx("size-3.5 shrink-0", solid[status], className)}
    >
      {GLYPHS[status]}
    </svg>
  );
}

const GLYPHS: Record<Status, ReactNode> = {
  check: (
    <>
      <path d="M7 1.2l5.8 5.8L7 12.8 1.2 7z" fill="currentColor" />
      <path
        d="M7 4.3v3.3"
        strokeWidth={1.5}
        strokeLinecap="round"
        className="stroke-check-solid-fg"
      />
      <circle cx={7} cy={9.6} r={0.85} className="fill-check-solid-fg" />
    </>
  ),
  done: (
    <path
      d="M2.8 7.3l2.7 2.7 5.7-6"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  ),
  running: <Arc />,
  checking: (
    <>
      <Arc />
      <path
        d="M5 7.1l1.4 1.4 2.6-2.8"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.4}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </>
  ),
  waiting: (
    <circle
      cx={7}
      cy={7}
      r={5}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.3}
      strokeDasharray="2 2"
    />
  ),
  paused: (
    <g fill="none" stroke="currentColor" strokeWidth={1.3}>
      <circle cx={7} cy={7} r={5.4} />
      <path d="M5.6 4.8v4.4M8.4 4.8v4.4" strokeLinecap="round" />
    </g>
  ),
  stopped: (
    <>
      <rect x={1.8} y={1.8} width={10.4} height={10.4} rx={2} fill="currentColor" />
      <path
        d="M5 5l4 4M9 5L5 9"
        strokeWidth={1.6}
        strokeLinecap="round"
        className="stroke-destructive-solid-fg"
      />
    </>
  ),
};

/** A ring with a turning arc; only the arc turns, so a glyph inside it stays still. */
function Arc() {
  return (
    <g fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round">
      <circle cx={7} cy={7} r={5.6} strokeOpacity={0.28} />
      <path
        d="M7 1.4a5.6 5.6 0 0 1 5.6 5.6"
        className="origin-[7px_7px] animate-[spin_1.6s_linear_infinite] motion-reduce:animate-none"
      />
    </g>
  );
}
