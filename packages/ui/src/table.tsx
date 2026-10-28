/**
 * Data table for lists like the runs list and a task's values. Columns
 * declare how to render a cell; rows become clickable when `onRowClick` is
 * set (Enter works too). An empty `rows` shows `empty` across the table.
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
        <tbody className="[&>tr:last-child>td]:border-b-0">
          {rows.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className="px-4 py-6 text-ui text-fg-subtle">
                {empty}
              </td>
            </tr>
          ) : (
            rows.map((row) => (
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
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
