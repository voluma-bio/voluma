/**
 * A titled dashboard block: a 36 px head (title, count, tools on the right), a body (usually a
 * `List`), and a foot that links to the full section or says what comes next. Boxes sit on the
 * chassis at 1 px seams; the page lays them out.
 */
import type { ReactNode } from "react";
import { cx } from "./cx";

export type BoxProps = {
  title: ReactNode;
  /** A Count after the title. */
  count?: ReactNode;
  /** The box's own controls or a quiet fact, on the right of the head. */
  tools?: ReactNode;
  /** A link to the full section, or a line on what comes next. */
  foot?: ReactNode;
  children: ReactNode;
  className?: string;
};

export function Box({ title, count, tools, foot, children, className }: BoxProps) {
  return (
    <section className={cx("min-w-0 bg-card", className)}>
      <header className="flex h-(--panel-head-h) items-center gap-2 border-b border-border px-4">
        <h2 className="m-0 truncate text-sm font-semibold">{title}</h2>
        {count}
        {tools && <div className="ml-auto flex items-center gap-2">{tools}</div>}
      </header>
      {children}
      {foot && (
        <footer className="grid gap-1.5 border-t border-border px-4 pt-2 pb-3 text-sm text-fg-subtle">
          {foot}
        </footer>
      )}
    </section>
  );
}
