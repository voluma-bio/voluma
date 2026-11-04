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
  /** A compact title/facts row for a sample workspace; wraps when space runs out. */
  inline?: boolean;
  actions?: ReactNode;
  className?: string;
};

export function PageHead({
  title,
  count,
  subtitle,
  inline = false,
  actions,
  className,
}: PageHeadProps) {
  return (
    <header
      className={cx(
        "flex shrink-0 flex-wrap border-b border-border bg-card px-6",
        inline ? "items-center gap-x-4 gap-y-1 py-2" : "items-start gap-x-6 gap-y-3 pt-4 pb-3.5",
        className,
      )}
    >
      <div
        className={cx(
          "min-w-0 flex-[1_1_16rem]",
          inline && "flex flex-wrap items-center gap-x-4 gap-y-1",
        )}
      >
        <div className="flex min-w-0 items-center gap-2.5">
          <h1
            className={cx(
              "m-0 min-w-0 break-words font-semibold",
              inline ? "text-base" : "text-xl",
            )}
          >
            {title}
          </h1>
          {count}
        </div>
        {subtitle && (
          <div className={cx("min-w-0 text-sm text-muted-foreground", !inline && "mt-0.5")}>
            {subtitle}
          </div>
        )}
      </div>
      {actions && <div className="flex max-w-full flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}
