/**
 * Count: a small number after a heading ("To check 18"). The tone says what the number counts
 * when that matters: items to check, stopped runs, running ones. A row's state with its number
 * ("5 to check") is a StatusMark, not a Count.
 */
import { cx } from "./cx";

export type CountTone = "neutral" | "check" | "running" | "stopped";

const tones: Record<CountTone, string> = {
  neutral: "bg-secondary text-muted-foreground",
  check: "bg-check-tint text-check",
  running: "bg-info-tint text-info",
  stopped: "bg-destructive-tint text-destructive",
};

export type CountProps = {
  children: number;
  tone?: CountTone;
  className?: string;
};

export function Count({ children, tone = "neutral", className }: CountProps) {
  return (
    <span
      className={cx(
        "inline-flex h-4.5 min-w-5 shrink-0 items-center justify-center rounded-full px-1.5 font-mono text-xs leading-none font-medium tabular-nums whitespace-nowrap",
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}
