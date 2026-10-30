/**
 * A list with a head: the Row look (40 px rows, compact 30 px, hover, ice selection, a chevron
 * that opens a row in place on a guide line, an arrow on hover for rows that go somewhere) on a
 * real `<table>`, so columns size to their content and screen readers name each cell by its head.
 *
 * Columns declare how to render a cell. With `rowLink` the first column's content becomes the
 * row's link, stretched over the row; with `rowDetail` a row opens in place. An empty `rows`
 * shows `empty` across the table. With `groupOf`, a head row names each run of rows sharing a
 * group; the caller orders rows by group. Arrow keys move between rows.
 */
import { ArrowRight } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
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
  stretchedClass,
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

  return (
    <div className={cx("overflow-x-auto rounded-lg border border-border bg-card", className)}>
      <table aria-label={label} onKeyDown={moveRowFocus} className="w-full border-collapse">
        <thead>
          <tr className="h-[30px] border-b border-border text-xs font-medium text-fg-subtle">
            {lead && <td aria-hidden className="w-7 pl-4" />}
            {columns.map((column, i) => (
              <th
                key={column.key}
                scope="col"
                className={cx(
                  "py-1.5 align-bottom font-medium",
                  pad(i === 0, i === columns.length - 1),
                  column.align === "end" ? "text-right" : "text-left",
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
                    {section.name}
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
                const first = (content: ReactNode) => {
                  if (to !== undefined) {
                    const props: LinkRenderProps = {
                      className: cx("block", stretchedClass),
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
                        className={cx("block cursor-pointer text-left", stretchedClass)}
                      >
                        {content}
                      </button>
                    );
                  return content;
                };
                return [
                  <tr
                    key={key}
                    aria-current={selected || undefined}
                    className={cx(
                      "group/row relative border-t border-border first:border-t-0",
                      compact ? "h-(--row-compact-h)" : "h-(--row-h)",
                      control && "hover:bg-accent",
                      selected &&
                        "bg-select-tint inset-ring inset-ring-select-dim hover:bg-select-tint",
                    )}
                  >
                    {lead && (
                      <td className="w-7 pr-0 pl-4 align-middle">
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
                          i === 0 && "font-medium",
                        )}
                      >
                        <div className={raiseControls}>
                          {i === 0 ? first(column.cell(row)) : column.cell(row)}
                        </div>
                      </td>
                    ))}
                    {trail && (
                      <td className="w-8 pr-4 align-middle">
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
  );
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
