/**
 * Status chip for lists, tables and headers: the one chip Home, the study
 * page, the run page and the review share. It takes a tone, not a status: the
 * caller maps its own statuses (task, run, structure) to a tone and label, so
 * this component stays independent of the contracts (`@voluma/run-view`
 * maps a `Run`).
 */
import type { ReactNode } from "react";
import { cx } from "./cx";

/** neutral: pending, stopped. primary: done, reviewed. check: to check. info: running, corrected. destructive: failed. */
export type StatusTone = "neutral" | "primary" | "check" | "info" | "destructive";

export type StatusBadgeProps = {
  tone: StatusTone;
  children: ReactNode;
  className?: string;
};

const tones: Record<StatusTone, string> = {
  neutral: "bg-muted text-muted-foreground",
  primary: "bg-primary-tint text-primary-strong",
  check: "bg-check-tint text-check",
  info: "bg-info-tint text-info",
  destructive: "bg-destructive-tint text-destructive",
};

export function StatusBadge({ tone, children, className }: StatusBadgeProps) {
  return (
    <span
      className={cx(
        "inline-flex w-max items-center rounded-full px-2.5 py-px text-meta font-medium whitespace-nowrap",
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}
