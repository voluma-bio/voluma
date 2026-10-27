/**
 * Small status label for lists and tables. It takes a tone, not a status: the
 * caller maps its own statuses (task, run, structure) to a tone, so this
 * component stays independent of the contracts.
 */
import type { ReactNode } from "react";
import { cx } from "./cx";

/** neutral: pending, stopped. accent: done, reviewed. check: to check. info: running, corrected. danger: failed. */
export type StatusTone = "neutral" | "accent" | "check" | "info" | "danger";

export type StatusBadgeProps = {
  tone: StatusTone;
  children: ReactNode;
  className?: string;
};

const tones: Record<StatusTone, string> = {
  neutral: "bg-raised text-fg-muted",
  accent: "bg-accent-tint text-accent-strong",
  check: "bg-check-tint text-check",
  info: "bg-info-tint text-info",
  danger: "bg-danger-tint text-danger",
};

export function StatusBadge({ tone, children, className }: StatusBadgeProps) {
  return (
    <span
      className={cx(
        "inline-flex w-max items-center rounded-md px-2 py-px text-meta font-medium whitespace-nowrap",
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}
