/**
 * Chip: a short mono tag for a fact or label ("coronal 211", "Attempt 2", "after Nov 4"). An icon
 * may lead it. Not a status: states use `StatusMark`.
 */
import type { ReactNode } from "react";
import { cx } from "./cx";

export type ChipProps = {
  children: ReactNode;
  className?: string;
};

export function Chip({ children, className }: ChipProps) {
  return (
    <span
      className={cx(
        "inline-flex h-4.5 shrink-0 items-center gap-1 rounded-sm px-1.5 font-mono text-xs leading-none font-medium whitespace-nowrap text-muted-foreground shadow-[inset_0_0_0_1px_var(--line-strong)] [&_svg]:size-3 [&_svg]:shrink-0",
        className,
      )}
    >
      {children}
    </span>
  );
}
