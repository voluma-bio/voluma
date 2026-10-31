import type { Meta, StoryObj } from "@storybook/react-vite";
import { Count } from "./count";

/**
 * **What:** a small mono number after a title or on a row. **Why:** one format for counts
 * (today there are eight). **Where:** strip icons (18, 5), panel heads, study panel rows, scan
 * rows and box heads. The tone says what it counts when that matters: amber for items to check,
 * red for stopped, violet for running.
 */
const meta = {
  title: "Parts/Count",
  component: Count,
  args: { children: 20 },
} satisfies Meta<typeof Count>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Neutral: Story = {};
export const ToCheck: Story = { args: { tone: "check", children: 18 } };
export const Running: Story = { args: { tone: "running", children: 2 } };
export const Stopped: Story = { args: { tone: "stopped", children: 2 } };
/** After a title, as in a panel head. */
export const AfterATitle: Story = {
  render: () => (
    <div className="grid gap-3">
      <h3 className="m-0 flex items-center gap-2 text-base font-semibold">
        Scans <Count>{20}</Count>
      </h3>
      <h3 className="m-0 flex items-center gap-2 text-base font-semibold">
        To check <Count tone="check">{18}</Count>
      </h3>
    </div>
  ),
};
