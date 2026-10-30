/**
 * What a list or panel shows when it has no rows: nothing yet (`EmptyState` says what will fill
 * it), still loading (`LoadingState` keeps the rows' shapes) or failed (`ErrorState` says what
 * happened and offers a retry). One pattern each, everywhere.
 */
import { OctagonX } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "./button";
import { cx } from "./cx";
import type { Density } from "./row";

export type EmptyStateProps = {
  /** What isn't here, e.g. "Nothing to check yet". */
  title: string;
  /** What will fill it, e.g. "Items appear as each scan's run finishes." */
  children?: ReactNode;
  className?: string;
};

export function EmptyState({ title, children, className }: EmptyStateProps) {
  return (
    <div className={cx("px-4 py-8 text-center text-fg-subtle", className)}>
      <p className="m-0 font-medium text-foreground">{title}</p>
      {children && <p className="m-0 mt-0.5 text-pretty">{children}</p>}
    </div>
  );
}

export type LoadingStateProps = {
  /** How many rows to hold; match what usually arrives. */
  rows?: number;
  density?: Density;
  /** Spoken while loading, e.g. "Loading scans". */
  label?: string;
  className?: string;
};

export function LoadingState({
  rows = 3,
  density = "comfortable",
  label = "Loading",
  className,
}: LoadingStateProps) {
  const compact = density === "compact";
  return (
    // Shown after a short delay (`animate-appear`), so a fast load doesn't flash it.
    <div role="status" className={cx("animate-appear motion-reduce:animate-none", className)}>
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }, (_, i) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: placeholders have no identity
          key={i}
          aria-hidden
          className={cx(
            "grid grid-cols-[16px_minmax(0,1fr)_120px_80px] items-center gap-3 px-4 [&+&]:border-t [&+&]:border-border",
            compact ? "h-(--row-compact-h)" : "h-(--row-h)",
          )}
        >
          <span />
          <div className="grid gap-1.5">
            {/* Widths vary so the rows read as text, not as a bar chart. */}
            <Bone width={`${40 + ((i * 13) % 40)}%`} />
            {!compact && <Bone width={`${25 + ((i * 9) % 30)}%`} short />}
          </div>
          <Bone />
          <Bone />
        </div>
      ))}
    </div>
  );
}

function Bone({ width = "100%", short }: { width?: string; short?: boolean }) {
  return (
    <span
      style={{ width }}
      className={cx(
        "block animate-pulse rounded-sm bg-secondary motion-reduce:animate-none",
        short ? "h-2" : "h-2.5",
      )}
    />
  );
}

export type ErrorStateProps = {
  /** What happened, e.g. "Couldn't load the slices". */
  title: string;
  /** Why, and what is safe, e.g. "The scan file didn't answer. Your checks so far are saved." */
  children?: ReactNode;
  /** Offers a retry button when given. */
  onRetry?: () => void;
  retryLabel?: string;
  className?: string;
};

export function ErrorState({
  title,
  children,
  onRetry,
  retryLabel = "Try again",
  className,
}: ErrorStateProps) {
  return (
    <div
      role="alert"
      className={cx(
        "flex items-start gap-3 rounded-md bg-destructive-tint px-4 py-3 text-foreground",
        className,
      )}
    >
      {/* Stands in for the Stopped StatusMark until it lands. */}
      <OctagonX aria-hidden className="mt-0.5 size-4 shrink-0 text-destructive" />
      <div className="min-w-0 flex-1">
        <p className="m-0 font-medium">{title}</p>
        {children && <p className="m-0 text-sm text-muted-foreground">{children}</p>}
      </div>
      {onRetry && (
        <Button size="sm" onClick={onRetry}>
          {retryLabel}
        </Button>
      )}
    </div>
  );
}
