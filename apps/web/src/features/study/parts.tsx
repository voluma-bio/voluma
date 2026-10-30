/** Small pieces the study feature's pages share: an action link and a progress bar. */
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
