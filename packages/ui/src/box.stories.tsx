import type { Meta, StoryObj } from "@storybook/react-vite";
import { Box } from "./box";
import { Count } from "./count";
import { List, Row, RowLink } from "./row";
import { EmptyState } from "./states";
import { StatusMark } from "./status-mark";

/**
 * **What:** a titled dashboard block: a 36 px head with title, count and tools, a body (usually
 * a list) and a foot that links to the full section or says what comes next. **Why:** one block
 * in place of 18 card sites with 8 paddings. **Where:** the study dashboard and Home (Needs you,
 * Running now, Spent).
 */
const count = (n: number, check?: boolean) => <Count tone={check ? "check" : "neutral"}>{n}</Count>;

const meta = {
  title: "Parts/Box",
  component: Box,
  args: {
    title: "Running now",
    count: count(3),
    tools: <span className="text-sm text-fg-subtle">3 at a time</span>,
    foot: "OA7-7, OA7-9 and OA7-19 start as these finish.",
    children: (
      <List columns="auto">
        <Row
          title="OA7-6, Tibial IIOC"
          subtitle="Tracing the growth plate"
          cells={[<StatusMark key="s" status="running" label="4 min" />]}
        />
        <Row
          title="OA7-18, Trabecular thickness"
          subtitle="Measuring in ROI-3"
          cells={[<StatusMark key="s" status="running" label="9 min" />]}
        />
      </List>
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
    children: (
      <List columns="110px">
        <RowLink
          to="#oa7-4"
          title="OA7-4, left knee"
          subtitle="Osteophyte merges with the condyle"
          cells={[<StatusMark key="s" status="check" label="2 to check" />]}
        />
        <RowLink
          to="#oa7-15"
          title="OA7-15, right knee"
          subtitle="Stopped during Orientation"
          cells={[<StatusMark key="s" status="stopped" />]}
        />
      </List>
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
      <EmptyState title="Nothing needs you">Items appear as each scan's run finishes.</EmptyState>
    ),
  },
};
