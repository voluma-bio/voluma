/**
 * Progress: how far along a set of tasks or scans is, and where it's stuck. `cells` draws one cell
 * per task or scan in the given order; `bar` sums the same states into one thin bar (done, to
 * check, running, checking, paused, stopped; waiting is the empty rest), for sets too big to
 * draw cell by cell. Its accessible name counts each state.
 */
import type { ReactNode } from "react";
import { cx } from "./cx";
import { STATUS_WORD, type Status } from "./status-mark";

export type ProgressProps = {
  /** One state per task or scan. */
  states: Status[];
  look?: "cells" | "bar";
  /** Shown after it in mono, e.g. "11 of 20". */
  label?: ReactNode;
  className?: string;
};

const BAR_ORDER: Status[] = ["done", "check", "running", "checking", "paused", "stopped"];

const fill: Record<Status, string> = {
  done: "bg-done-solid",
  check: "bg-check-solid",
  running: "bg-info-solid",
  checking: "bg-info-solid",
  paused: "bg-idle",
  stopped: "bg-destructive-solid",
  waiting: "",
};

// A waiting cell is an empty outline; done and paused cells sit back so what needs you stands out.
const cell: Record<Status, string> = {
  ...fill,
  done: "bg-done-solid opacity-60",
  paused: "bg-idle opacity-60",
  waiting: "shadow-[inset_0_0_0_1px_var(--line-strong)]",
};

export function Progress({ states, look = "cells", label, className }: ProgressProps) {
  const counts = new Map<Status, number>();
  for (const s of states) counts.set(s, (counts.get(s) ?? 0) + 1);
  const name =
    [...BAR_ORDER, "waiting" as const]
      .filter((s) => counts.has(s))
      .map((s) => `${counts.get(s)} ${STATUS_WORD[s].toLowerCase()}`)
      .join(", ") || "Nothing yet";

  return (
    <span className={cx("flex min-w-0 items-center gap-2", className)}>
      {look === "cells" ? (
        <span role="img" aria-label={name} className="flex flex-wrap gap-0.5">
          {states.map((s, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: cells are positions, not items.
            <i key={i} className={cx("block h-2.5 w-1.75 rounded-[1px]", cell[s])} />
          ))}
        </span>
      ) : (
        <span
          role="img"
          aria-label={name}
          className="flex h-1 min-w-15 flex-1 overflow-hidden rounded-full bg-muted shadow-[inset_0_0_0_1px_var(--border)]"
        >
          {BAR_ORDER.filter((s) => counts.has(s)).map((s) => (
            <i
              key={s}
              className={cx("block h-full", fill[s])}
              style={{ width: `${(100 * (counts.get(s) ?? 0)) / states.length}%` }}
            />
          ))}
        </span>
      )}
      {label != null && (
        <span className="min-w-10 shrink-0 text-right font-mono text-xs tabular-nums text-muted-foreground">
          {label}
        </span>
      )}
    </span>
  );
}
