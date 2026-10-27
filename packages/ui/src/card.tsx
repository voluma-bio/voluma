/** Bordered surface for a task, a workflow start option or a To check item. */
import type { HTMLAttributes } from "react";
import { cx } from "./cx";

export type CardProps = HTMLAttributes<HTMLDivElement> & {
  /** Highlights the border on hover, for cards that open or select something. */
  interactive?: boolean;
};

export function Card({ interactive = false, className, ...props }: CardProps) {
  return (
    <div
      className={cx(
        "rounded-xl border border-line bg-surface p-4",
        interactive && "transition-colors hover:border-accent",
        className,
      )}
      {...props}
    />
  );
}
