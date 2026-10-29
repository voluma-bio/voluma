/**
 * Data table for lists like the runs list and a task's values. Columns
 * declare how to render a cell; rows become clickable when `onRowClick` is
 * set (Enter works too). An empty `rows` shows `empty` across the table. With `groupOf`, a
 * header row names each run of rows sharing a group; the caller orders rows by group.
 */
import { Fragment, type ReactNode } from "react";
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
        <tbody className="[&>tr:last-child>td]:border-b-0">
          {rows.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className="px-4 py-6 text-ui text-fg-subtle">
                {empty}
              </td>
            </tr>
          ) : (
            rows.map((row, i) => (
              <Fragment key={rowKey(row)}>
                {groupOf && (i === 0 || groupOf(rows[i - 1] as Row) !== groupOf(row)) && (
                  <tr>
                    <th
                      scope="colgroup"
                      colSpan={columns.length}
                      className="border-b border-line-subtle bg-muted px-4 py-1.5 text-left text-meta font-medium text-fg-subtle"
                    >
                      {groupOf(row)}
                    </th>
                  </tr>
                )}
                <tr
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
              </Fragment>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
