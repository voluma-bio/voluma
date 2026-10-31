import type { Meta, StoryObj } from "@storybook/react-vite";
import { StatusMark } from "./status-mark";
import { Table, type TableColumn } from "./table";

/**
 * **What:** a list with a head: the Row look on a real table, so columns size to their content.
 * Comfortable rows are 40 px, compact 30 px. Rows can go somewhere (`rowLink`, arrow on hover),
 * open in place (`rowDetail`) or both, and sit under group heads (`groupOf`). **Why:** one table
 * for values and scan lists, in place of six table-like grids. **Where:** Scans, Results, a
 * task's values, the runs list.
 */
type Scan = {
  id: string;
  group: string;
  knee: string;
  state: "check" | "running" | "stopped" | "done";
  checks?: number;
  bvtv?: number;
};

const scans: Scan[] = [
  { id: "OA7-4", group: "DMM", knee: "left", state: "check", checks: 2, bvtv: 55.1 },
  { id: "OA7-6", group: "DMM", knee: "left", state: "running" },
  { id: "OA7-11", group: "Sham", knee: "right", state: "done", bvtv: 61.4 },
  { id: "OA7-15", group: "Sham", knee: "right", state: "stopped" },
];

const columns: TableColumn<Scan>[] = [
  {
    key: "scan",
    header: "Scan",
    cell: (s) => <span className="font-mono whitespace-nowrap">{s.id}</span>,
  },
  { key: "knee", header: "Knee", cell: (s) => `${s.group}, ${s.knee} knee` },
  {
    key: "status",
    header: "Status",
    cell: (s) => (
      <StatusMark status={s.state} label={s.checks ? `${s.checks} to check` : undefined} />
    ),
  },
  {
    key: "bvtv",
    header: "BV/TV, %",
    align: "end",
    cell: (s) =>
      s.bvtv === undefined ? (
        <span className="text-fg-subtle">–</span>
      ) : (
        <span className="font-mono">{s.bvtv.toFixed(1)}</span>
      ),
  },
];

const meta = {
  title: "Parts/Table",
  component: Table<Scan>,
  args: { label: "Scans", columns, rows: scans, rowKey: (s: Scan) => s.id },
} satisfies Meta<typeof Table<Scan>>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Rows that go somewhere: the whole row is the link, an arrow shows on hover. */
export const Comfortable: Story = { args: { rowLink: (s) => `#${s.id}` } };

/** Same list, 30 px rows. */
export const Compact: Story = { args: { density: "compact", rowLink: (s) => `#${s.id}` } };

/** Rows that open in place to their tasks; the chevron opens without navigating. */
export const OpensInPlace: Story = {
  args: {
    rowLink: (s) => `#${s.id}`,
    rowDetail: (s) =>
      s.state === "running" ? undefined : (
        <p className="m-0 text-sm text-fg-subtle">{s.id}'s tasks open here.</p>
      ),
  },
};

/** Grouped under heads; one row selected. */
export const Grouped: Story = {
  args: {
    groupOf: (s) => s.group,
    selectedKey: "OA7-11",
    rowDetail: () => <p className="m-0 text-sm text-fg-subtle">The scan's tasks open here.</p>,
  },
};

/** No rows: the table says what will fill it. */
export const Empty: Story = {
  args: { rows: [], empty: "Scans appear here once you add them to the study." },
};

/** Static rows: no link, no detail, no hover. */
export const Static: Story = {};

/**
 * Wider than its box: the rest scrolls sideways under the held first column (and chevron); a
 * fade marks the side with more, a shadow the held column once scrolled.
 */
export const Scrolls: Story = {
  args: {
    groupOf: (s) => s.group,
    rowLink: (s) => `#${s.id}`,
    rowDetail: () => <p className="m-0 text-sm text-fg-subtle">The scan's tasks open here.</p>,
    columns: [
      ...columns,
      ...["Patella volume", "Medial osteophyte volume", "Tibial cortical thickness"].map(
        (name): TableColumn<Scan> => ({
          key: name,
          header: <span className="inline-block w-28 whitespace-normal">{name}</span>,
          align: "end",
          cell: () => <span className="font-mono">0.135</span>,
        }),
      ),
    ],
  },
  render: (args) => (
    <div className="max-w-md">
      <Table {...args} />
    </div>
  ),
};
