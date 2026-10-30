/**
 * Data table for lists like the runs list and a task's values. Columns
 * declare how to render a cell; rows become clickable when `onRowClick` is
 * set (Enter works too). An empty `rows` shows `empty` across the table. With `groupOf`, a
 * header row names each run of rows sharing a group; the caller orders rows by group.
 */
import type { ReactNode } from "react";
import { cx } from "./cx";

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
  onRowClick?: (row: Row) => void;
  /** The group header a row sits under, e.g. "DMM, 4 knees". */
  groupOf?: (row: Row) => string;
  empty?: ReactNode;
  /** Accessible name for the table. */
  label: string;
  className?: string;
};

export function Table<Row>({
  columns,
  rows,
  rowKey,
  onRowClick,
  groupOf,
  empty,
  label,
  className,
}: TableProps<Row>) {
  return (
    <div className={cx("overflow-x-auto rounded-xl border border-border bg-card", className)}>
      <table aria-label={label} className="w-full border-collapse text-sm">
        <thead>
          <tr>
            {columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                className={cx(
                  "border-b border-border px-4 py-2.5 text-meta font-medium text-fg-subtle",
                  column.align === "end" ? "text-right" : "text-left",
                )}
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        {rows.length === 0 ? (
          <tbody>
            <tr>
              <td colSpan={columns.length} className="px-4 py-6 text-ui text-fg-subtle">
                {empty}
              </td>
            </tr>
          </tbody>
        ) : (
          sections(rows, groupOf).map((section) => (
            <tbody key={section.name ?? ""} className="[&>tr:last-child>td]:border-b-0">
              {section.name !== undefined && (
                <tr>
                  <th
                    scope="rowgroup"
                    colSpan={columns.length}
                    className="border-y border-line-subtle bg-muted px-4 py-1.5 text-left text-meta font-medium text-fg-subtle"
                  >
                    {section.name}
                  </th>
                </tr>
              )}
              {section.rows.map((row) => (
                <tr
                  key={rowKey(row)}
                  tabIndex={onRowClick ? 0 : undefined}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  onKeyDown={
                    onRowClick
                      ? (event) => {
                          if (event.key === "Enter") onRowClick(row);
                        }
                      : undefined
                  }
                  className={cx(
                    onRowClick &&
                      "cursor-pointer hover:bg-background focus-visible:bg-background focus-visible:outline-none",
                  )}
                >
                  {columns.map((column) => (
                    <td
                      key={column.key}
                      className={cx(
                        "border-b border-line-subtle px-4 py-3 align-top text-foreground",
                        column.align === "end" && "text-right tabular-nums",
                      )}
                    >
                      {column.cell(row)}
                    </td>
                  ))}
                </tr>
              ))}
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
