/**
 * The head of a page in the main area: its title (with a Count when the page is a list), one or
 * two lines of facts about what it shows, and the page's actions on the right (at most one
 * primary). A line under it separates it from the page's boxes.
 */
import type { ReactNode } from "react";
import { cx } from "./cx";

export type PageHeadProps = {
  title: ReactNode;
  /** A Count after the title. */
  count?: ReactNode;
  /** Facts about the data shown (its scope, its groups), never about the screen. */
  subtitle?: ReactNode;
  actions?: ReactNode;
  className?: string;
};

export function PageHead({ title, count, subtitle, actions, className }: PageHeadProps) {
  return (
    <header
      className={cx(
        "flex flex-wrap items-start gap-x-6 gap-y-3 border-b border-border bg-card px-6 pt-4 pb-3.5",
        className,
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2.5">
          <h1 className="m-0 min-w-0 truncate text-xl font-semibold">{title}</h1>
          {count}
        </div>
        {subtitle && <div className="mt-0.5 text-sm text-muted-foreground">{subtitle}</div>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </header>
  );
}
