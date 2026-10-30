/** Small pieces the study feature's pages share: an action link, a progress bar, loading and load-error lines. */
import { type ButtonProps, buttonClass } from "@voluma/ui";
import type { ReactNode } from "react";
import { Link } from "react-router";

export function ButtonLink({
  to,
  variant,
  size,
  children,
}: { to: string; children: ReactNode } & Pick<ButtonProps, "variant" | "size">) {
  return (
    <Link to={to} className={buttonClass({ variant, size })}>
      {children}
    </Link>
  );
}

/** A thin bar; with nothing to count (`total` 0) it shows empty. */
export function ProgressBar({
  done,
  total,
  label,
}: {
  done: number;
  total: number;
  label: string;
}) {
  const percent = total > 0 ? Math.min(100, (done / total) * 100) : 0;
  return (
    <span
      role="progressbar"
      aria-label={label}
      aria-valuenow={done}
      aria-valuemin={0}
      aria-valuemax={total}
      className="block h-1.5 w-full overflow-hidden rounded-full bg-muted"
    >
      <span
        className="block h-full rounded-full bg-primary transition-[width] duration-300"
        style={{ width: `${percent}%` }}
      />
    </span>
  );
}

/** Shown only when loading is slow, so a fast load doesn't flash it. */
export function Delayed({ children }: { children: ReactNode }) {
  return (
    <p
      aria-busy="true"
      className="animate-[appear_200ms_ease-out_600ms_both] text-ui text-muted-foreground"
    >
      {children}
    </p>
  );
}

export function LoadError({ what, retry }: { what: string; retry: () => void }) {
  return (
    <p role="alert" className="text-destructive">
      Couldn't load {what}.{" "}
      <button type="button" className="underline" onClick={retry}>
        Try again
      </button>
    </p>
  );
}
