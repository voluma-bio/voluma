/**
 * Where you are, in the header line: the places above this screen as links, then this screen.
 * A screen renders it inside `ShellHeading`. Links use the app's router through `LinkTo`.
 */
import { Fragment } from "react";
import { cx } from "./cx";
import type { LinkTo } from "./row";

export type BreadcrumbProps = {
  /** The places above this screen, outermost first. */
  trail?: { label: string; to: LinkTo }[];
  /** This screen. */
  current: string;
  className?: string;
};

const linkClass =
  "truncate rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring";

export function Breadcrumb({ trail = [], current, className }: BreadcrumbProps) {
  return (
    <nav aria-label="Where you are" className={cx("min-w-0", className)}>
      <ol className="m-0 flex min-w-0 list-none items-center gap-2 p-0 text-sm">
        {trail.map(({ label, to }) => (
          <Fragment key={label}>
            <li className="min-w-0 truncate">
              {typeof to === "string" ? (
                <a href={to} className={linkClass}>
                  {label}
                </a>
              ) : (
                to({ className: linkClass, children: label, "data-row-control": "" })
              )}
            </li>
            <li aria-hidden className="text-fg-subtle">
              /
            </li>
          </Fragment>
        ))}
        <li aria-current="page" className="min-w-0 truncate font-medium">
          {current}
        </li>
      </ol>
    </nav>
  );
}
