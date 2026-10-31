/**
 * A list with a head: the Row look (40 px rows, compact 30 px, hover, ice selection, a chevron
 * that opens a row in place on a guide line, an arrow on hover for rows that go somewhere) on a
 * real `<table>`, so columns size to their content and screen readers name each cell by its head.
 *
 * Columns declare how to render a cell. With `rowLink` the first column's content becomes the
 * row's link, stretched over the row; with `rowDetail` a row opens in place. An empty `rows`
 * shows `empty` across the table. With `groupOf`, a head row names each run of rows sharing a
 * group; the caller orders rows by group. Arrow keys move between rows.
 *
 * A table wider than its box scrolls sideways with its first column (and the chevron before it)
 * held in place: a shadow marks the held column once the rest scrolls under it, and a fade marks
 * the side with more to see. A held cell is positioned, which would shrink the row's stretched
 * control to that cell, so the rest of the row is a mouse-only copy of it in the last cell, and
 * one layer in the held cell draws the row's selection outline and focus ring over its width.
 */
import { ArrowRight } from "lucide-react";
import { type ReactNode, useId, useLayoutEffect, useRef, useState } from "react";
import { cx } from "./cx";
import {
  Chevron,
  ChevronToggle,
  type Density,
  type LinkRenderProps,
  type LinkTo,
  moveRowFocus,
  raiseControls,
  rowBodyClass,
} from "./row";

export type TableColumn<Row> = {
  key: string;
  header: ReactNode;
  cell: (row: Row) => ReactNode;
  /** `end` right-aligns with tabular figures, for numbers and times. */
  align?: "start" | "end";
};

export type TableProps<Row> = {
  columns: TableColumn<Row>[];
  rows: Row[];
  rowKey: (row: Row) => string;
  /** Accessible name for the table. */
  label: string;
  /** `compact` is 30 px rows. */
  density?: Density;
  /** Where a row goes; the whole row navigates. `undefined` leaves that row in place. */
  rowLink?: (row: Row) => LinkTo | undefined;
  /** The layer a row opens to in place. `undefined` leaves that row closed, without a chevron. */
  rowDetail?: (row: Row) => ReactNode | undefined;
  /** The selected row's key, drawn with an ice outline. */
  selectedKey?: string;
  /** The group head a row sits under, e.g. "DMM, 4 scans". */
  groupOf?: (row: Row) => string;
  empty?: ReactNode;
  className?: string;
};

export function Table<Row>({
  columns,
  rows,
  rowKey,
  label,
  density = "comfortable",
  rowLink,
  rowDetail,
  selectedKey,
  groupOf,
  empty,
  className,
}: TableProps<Row>) {
  const id = useId();
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const toggle = (key: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  const lead = rowDetail !== undefined;
  const trail = rowLink !== undefined;
  const span = columns.length + (lead ? 1 : 0) + (trail ? 1 : 0);
  const compact = density === "compact";
  const pad = (first: boolean, last: boolean) =>
    cx(first && !lead ? "pl-4" : "pl-3", last && !trail ? "pr-4" : "pr-3");

  const { ref, scrolled, more } = useScrollEdges();
  // The held cells: opaque, above cells scrolling under them and their raised controls.
  const held = "sticky z-[2] bg-card";
  const leadCell = cx(held, "left-0 w-7 min-w-7 max-w-7 pr-0 pl-4");
  const firstHeld = cx(
    held,
    lead ? "left-7" : "left-0",
    scrolled &&
      "shadow-[inset_-1px_0_0_var(--line-strong),8px_0_8px_-6px_color-mix(in_oklch,var(--foreground)_18%,transparent)]",
  );

  return (
    <div
      className={cx("relative overflow-hidden rounded-lg border border-border bg-card", className)}
    >
      <div ref={ref} className="@container overflow-x-auto">
        <table aria-label={label} onKeyDown={moveRowFocus} className="w-full border-collapse">
          <thead>
            <tr className="h-[30px] border-b border-border text-xs font-medium text-fg-subtle">
              {lead && <td aria-hidden className={leadCell} />}
              {columns.map((column, i) => (
                <th
                  key={column.key}
                  scope="col"
                  className={cx(
                    "py-1.5 align-bottom font-medium",
                    pad(i === 0, i === columns.length - 1),
                    column.align === "end" ? "text-right" : "text-left",
                    i === 0 && firstHeld,
                  )}
                >
                  {column.header}
                </th>
              ))}
              {trail && <td aria-hidden className="w-8" />}
            </tr>
          </thead>
          {rows.length === 0 ? (
            <tbody>
              <tr>
                <td colSpan={span} className="px-4 py-6 text-sm text-fg-subtle">
                  {empty}
                </td>
              </tr>
            </tbody>
          ) : (
            sections(rows, groupOf).map((section) => (
              <tbody key={section.name ?? ""}>
                {section.name !== undefined && (
                  <tr>
                    <th
                      scope="rowgroup"
                      colSpan={span}
                      className="h-[30px] border-t border-border bg-muted px-4 text-left text-xs font-medium text-fg-subtle"
                    >
                      <span className="sticky left-4">{section.name}</span>
                    </th>
                  </tr>
                )}
                {section.rows.map((row) => {
                  const key = rowKey(row);
                  const to = rowLink?.(row);
                  const detail = rowDetail?.(row);
                  const isOpen = detail !== undefined && open.has(key);
                  const selected = key === selectedKey;
                  const detailId = `${id}-${key}`;
                  const control = to !== undefined || detail !== undefined;
                  // The row's control, stretched over its held cell; `copy` is the rest of the row.
                  const first = (content: ReactNode) => {
                    if (to !== undefined) {
                      const props: LinkRenderProps = {
                        className: cx("block", heldStretch),
                        children: content,
                        "data-row-control": "",
                      };
                      return typeof to === "string" ? <a href={to} {...props} /> : to(props);
                    }
                    if (detail !== undefined)
                      return (
                        <button
                          type="button"
                          data-row-control=""
                          aria-expanded={isOpen}
                          aria-controls={isOpen ? detailId : undefined}
                          onClick={() => toggle(key)}
                          className={cx("block cursor-pointer text-left", heldStretch)}
                        >
                          {content}
                        </button>
                      );
                    return content;
                  };
                  const copy = control && (
                    <RowCopy
                      to={to}
                      onToggle={detail !== undefined ? () => toggle(key) : undefined}
                    />
                  );
                  return [
                    <tr
                      key={key}
                      aria-current={selected || undefined}
                      className={cx(
                        "group/row relative border-t border-border first:border-t-0",
                        compact ? "h-(--row-compact-h)" : "h-(--row-h)",
                        control && "hover:bg-accent",
                        selected && "bg-select-tint hover:bg-select-tint",
                      )}
                    >
                      {lead && (
                        <td
                          className={cx(
                            leadCell,
                            "align-middle",
                            control && !selected && "group-hover/row:bg-accent",
                            selected && "bg-linear-to-r from-select-tint to-select-tint",
                          )}
                        >
                          {detail !== undefined &&
                            (to !== undefined ? (
                              <ChevronToggle
                                open={isOpen}
                                controls={detailId}
                                onToggle={() => toggle(key)}
                              />
                            ) : (
                              <Chevron open={isOpen} />
                            ))}
                        </td>
                      )}
                      {columns.map((column, i) => (
                        <td
                          key={column.key}
                          className={cx(
                            "align-middle text-foreground",
                            compact ? "py-0.5" : "py-1.5",
                            pad(i === 0, i === columns.length - 1),
                            column.align === "end" && "text-right tabular-nums",
                            i === 0 &&
                              cx(
                                "font-medium",
                                firstHeld,
                                control && !selected && "group-hover/row:bg-accent",
                                selected && "bg-linear-to-r from-select-tint to-select-tint",
                              ),
                          )}
                        >
                          <div className={raiseControls}>
                            {i === 0 ? first(column.cell(row)) : column.cell(row)}
                          </div>
                          {i === 0 && (control || selected) && (
                            <RowRing selected={selected} lead={lead} />
                          )}
                          {!trail && i === columns.length - 1 && copy}
                        </td>
                      ))}
                      {trail && (
                        <td className="w-8 pr-4 align-middle">
                          {copy}
                          {to !== undefined && (
                            <ArrowRight
                              aria-hidden
                              className="ml-auto size-3.5 text-fg-subtle opacity-0 transition-opacity group-hover/row:opacity-100 motion-reduce:transition-none"
                            />
                          )}
                        </td>
                      )}
                    </tr>,
                    isOpen && (
                      <tr key={`${key}-detail`} className={cx(selected && "bg-select-tint")}>
                        <td
                          id={detailId}
                          colSpan={span}
                          className={cx(rowBodyClass, "pr-4 pl-11 before:left-[23px]")}
                        >
                          {detail}
                        </td>
                      </tr>
                    ),
                  ];
                })}
              </tbody>
            ))
          )}
        </table>
      </div>
      <div
        aria-hidden
        className={cx(
          "pointer-events-none absolute inset-y-0 right-0 z-[3] w-10 bg-linear-to-l from-card to-transparent transition-opacity motion-reduce:transition-none",
          more ? "opacity-100" : "opacity-0",
        )}
      />
    </div>
  );
}

/** The row's own control covers its held cell; the row's ring is `RowRing`'s. */
const heldStretch = "after:absolute after:inset-0 after:content-[''] focus-visible:outline-none";

const copyClass = "after:absolute after:inset-0 after:content-['']";

/**
 * The selected row's ice outline and the focus ring while the row's control has focus, drawn over
 * the row's visible width, held cells included, and never in the way of a click. It sits in the
 * held first cell, so its left edge stays put while the rest scrolls, and spans the scroller
 * (`100cqw`) from the row's left edge.
 */
function RowRing({ selected, lead }: { selected: boolean; lead: boolean }) {
  return (
    <span
      aria-hidden
      className={cx(
        "pointer-events-none absolute inset-y-0 z-[3] w-[100cqw]",
        lead ? "-left-7" : "left-0",
        selected && "inset-ring inset-ring-select-dim",
        "group-has-[[data-row-control]:focus-visible]/row:outline-2 group-has-[[data-row-control]:focus-visible]/row:-outline-offset-2 group-has-[[data-row-control]:focus-visible]/row:outline-ring",
      )}
    />
  );
}

/** The row's control again, for the mouse, stretched over the row under its held cells. */
function RowCopy({ to, onToggle }: { to: LinkTo | undefined; onToggle?: () => void }) {
  if (to === undefined)
    return <span aria-hidden className={cx("cursor-pointer", copyClass)} onClick={onToggle} />;
  if (typeof to !== "string")
    return to({ className: copyClass, children: null, tabIndex: -1, "aria-hidden": true });
  return (
    // biome-ignore lint/a11y/useAnchorContent: keyboards and screen readers reach the row's own link.
    <a href={to} tabIndex={-1} aria-hidden className={copyClass} />
  );
}

/** Whether the scroller is scrolled from its start, and whether more lies past its end. */
function useScrollEdges() {
  const ref = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ scrolled: false, more: false });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const scrolled = el.scrollLeft > 0;
      const more = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
      setEdges((e) => (e.scrolled === scrolled && e.more === more ? e : { scrolled, more }));
    };
    measure();
    el.addEventListener("scroll", measure, { passive: true });
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    if (el.firstElementChild) observer.observe(el.firstElementChild);
    return () => {
      el.removeEventListener("scroll", measure);
      observer.disconnect();
    };
  }, []);
  return { ref, ...edges };
}

/** Runs of consecutive rows sharing a group (one unnamed run without `groupOf`). */
function sections<Row>(rows: Row[], groupOf?: (row: Row) => string) {
  const out: { name: string | undefined; rows: Row[] }[] = [];
  for (const row of rows) {
    const name = groupOf?.(row);
    const last = out.at(-1);
    if (last && last.name === name) last.rows.push(row);
    else out.push({ name, rows: [row] });
  }
  return out;
}
