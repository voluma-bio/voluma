import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { PlaceholderStatus } from "./placeholder-status";
import { List, Row } from "./row";

/**
 * **What:** the one list part. A row shows a title, a subtitle, a status and cells; a row with
 * a next layer has a chevron and opens it in place, indented on a guide line, one level of detail
 * at a time. Selection (ice outline) drives the other views. **Why:** today there are nine ways
 * to expand something and six table-like grids; this is the one. **Where:** every list: scans,
 * items to check, tasks, values, files, agents (study panel, To check, Scans, ScanQueue, Report,
 * Agents tree, Box bodies). Rows that go somewhere are `RowLink`.
 *
 * Keyboard: Tab or the arrow keys move between rows; Enter opens the focused row. Statuses here
 * are a stand-in until StatusMark lands.
 */
const meta = {
  title: "Parts/Row",
  component: Row,
  args: { title: "Segmentation", subtitle: "3 values, 1 to check" },
  render: (args) => (
    <List columns="140px 90px" boxed>
      <Row {...args} />
    </List>
  ),
} satisfies Meta<typeof Row>;
export default meta;
type Story = StoryObj<typeof meta>;

const values = (
  <List columns="120px 130px">
    <Row
      title="Patella volume"
      cells={[
        <span key="v" className="ml-auto font-mono">
          1.26 <span className="text-fg-subtle">mm³</span>
        </span>,
        <span key="c" className="ml-auto text-sm text-fg-subtle">
          Second check: same
        </span>,
      ]}
    >
      <p className="m-0 text-sm text-fg-subtle">How the AI measured it.</p>
    </Row>
    <Row
      title="Medial meniscus volume"
      cells={[
        <span key="v" className="ml-auto font-mono">
          0.500 <span className="text-fg-subtle">mm³</span>
        </span>,
        <span key="c" className="ml-auto text-sm text-check">
          To check
        </span>,
      ]}
    />
  </List>
);

/** A closed row with a next layer: the summary answers "how is it going". */
export const Collapsed: Story = {
  args: {
    status: <PlaceholderStatus state="check" word="1 to check" />,
    cells: [
      <span key="t" className="ml-auto font-mono text-sm text-fg-subtle">
        10 min 2 s
      </span>,
    ],
    children: values,
  },
};

/** Open: the next layer sits below, indented on a guide line. Its rows open too. */
export const Open: Story = {
  args: {
    status: <PlaceholderStatus state="done" />,
    defaultOpen: true,
    children: values,
  },
};

/** Selected: an ice outline. The row that drives the views. */
export const Selected: Story = {
  args: {
    title: "Cortical thickness",
    subtitle: "Drives the other views",
    status: <PlaceholderStatus state="check" />,
    selected: true,
    onSelect: () => {},
  },
};

/** No next layer and nothing to select: no chevron, no hover, not focusable. */
export const NotExpandable: Story = {
  args: {
    title: "Orientation",
    subtitle: "Waiting for Segmentation",
    status: <PlaceholderStatus state="waiting" />,
  },
};

/** Long titles and subtitles cut off with an ellipsis instead of wrapping. */
export const LongText: Story = {
  args: {
    title: "Proximal tibial metaphysis trabecular thickness in the region below the growth plate",
    subtitle:
      "Measuring trabecular thickness in ROI-3 across every slice between the two landmarks",
    status: <PlaceholderStatus state="running" word="Task 4 of 9" />,
    children: values,
  },
};

/** A list of rows, one selected at a time. Arrow keys move; Enter selects and opens. */
export const InAList: Story = {
  render: () => {
    const [selected, setSelected] = useState("seg");
    const tasks = [
      {
        id: "orient",
        title: "Orientation",
        sub: "Aligned to the tibial axis",
        state: "done" as const,
      },
      { id: "seg", title: "Segmentation", sub: "3 values, 1 to check", state: "check" as const },
      {
        id: "cort",
        title: "Cortical thickness",
        sub: "Tracing the outer surface",
        state: "running" as const,
      },
      {
        id: "trab",
        title: "Trabecular thickness",
        sub: "Starts after Segmentation",
        state: "waiting" as const,
      },
    ];
    return (
      <List columns="120px" boxed label="Tasks">
        {tasks.map((t) => (
          <Row
            key={t.id}
            title={t.title}
            subtitle={t.sub}
            status={<PlaceholderStatus state={t.state} />}
            selected={selected === t.id}
            onSelect={() => setSelected(t.id)}
          >
            {values}
          </Row>
        ))}
      </List>
    );
  },
};

/** Compact: 30 px rows, subtitles hidden. */
export const Compact: Story = {
  render: () => (
    <List columns="120px" density="compact" boxed>
      <Row title="OA7-4" subtitle="DMM, left knee" status={<PlaceholderStatus state="check" />}>
        {values}
      </Row>
      <Row title="OA7-6" subtitle="DMM, left knee" status={<PlaceholderStatus state="running" />}>
        {values}
      </Row>
      <Row
        title="OA7-15"
        subtitle="Sham, right knee"
        status={<PlaceholderStatus state="stopped" />}
      />
    </List>
  ),
};
