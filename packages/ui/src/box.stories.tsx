import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ReactNode } from "react";
import { Box } from "./box";
import { Count } from "./count";
import { EmptyState } from "./states";
import { StatusMark } from "./status-mark";

/**
 * **What:** a titled dashboard block: a 36 px head with title, count and tools, a body (usually
 * a list) and a foot that links to the full section or says what comes next. **Why:** one block
 * in place of 18 card sites with 8 paddings. **Where:** the study dashboard and Home (Needs you,
 * Running now, Spent).
 */
const count = (n: number, check?: boolean) => <Count tone={check ? "check" : "neutral"}>{n}</Count>;

/** A line of a box's list: a name, what it says, and its status. */
const line = (name: string, says: string, status: ReactNode) => (
  <li key={name} className="flex items-center gap-3 px-4 py-1.5 text-sm">
    <span className="min-w-0 flex-1">
      <span className="font-medium">{name}</span>
      <span className="block truncate text-fg-subtle">{says}</span>
    </span>
    {status}
  </li>
);
const lines = (...items: ReactNode[]) => <ul className="m-0 list-none p-0">{items}</ul>;

const meta = {
  title: "Parts/Box",
  component: Box,
  args: {
    title: "Running now",
    count: count(3),
    tools: <span className="text-sm text-fg-subtle">3 at a time</span>,
    foot: "OA7-7, OA7-9 and OA7-19 start as these finish.",
    children: lines(
      line("OA7-6", "Tracing the growth plate", <StatusMark status="running" label="4 min" />),
      line("OA7-18", "Measuring in ROI-3", <StatusMark status="running" label="9 min" />),
    ),
  },
  // Boxes sit on the chassis, meeting at 1 px seams.
  decorators: [(Story) => <div className="grid max-w-md gap-px bg-background p-px">{Story()}</div>],
} satisfies Meta<typeof Box>;
export default meta;
type Story = StoryObj<typeof meta>;

export const WithFoot: Story = {};

/** A foot that is the way to the full section. */
export const NeedsYou: Story = {
  args: {
    title: "Needs you",
    count: count(7, true),
    tools: undefined,
    foot: (
      <a href="#to-check" className="text-primary-text hover:underline">
        See all 18 to check
      </a>
    ),
    children: lines(
      line(
        "OA7-4, left knee",
        "Osteophyte merges with the condyle",
        <StatusMark status="check" label="2 to check" />,
      ),
      line("OA7-15, right knee", "Stopped before it finished", <StatusMark status="stopped" />),
    ),
  },
};

export const Empty: Story = {
  args: {
    title: "Needs you",
    count: undefined,
    tools: undefined,
    foot: undefined,
    children: (
      <EmptyState title="Nothing needs you">Items appear as each sample's run finishes.</EmptyState>
    ),
  },
};
