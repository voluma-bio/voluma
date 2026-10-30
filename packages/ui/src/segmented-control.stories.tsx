import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { SegmentedControl } from "./segmented-control";

/**
 * **What:** two or three modes of one view; one is always on. Arrow keys move between them.
 * **Why:** one look for mode switches that were drawn ad hoc. **Where:** the matrix's Status /
 * Values, a list's Comfortable / Compact, the Agents stream filter.
 */
function Demo({ initial, options }: { initial: string; options: string[] }) {
  const [value, setValue] = useState(initial);
  return (
    <SegmentedControl
      label="Show"
      value={value}
      onValueChange={setValue}
      options={options.map((o) => ({ value: o, label: o }))}
    />
  );
}

const meta = {
  title: "Parts/SegmentedControl",
  component: Demo,
  args: { initial: "Status", options: ["Status", "Values"] },
} satisfies Meta<typeof Demo>;
export default meta;
type Story = StoryObj<typeof meta>;

export const TwoModes: Story = {};
export const ThreeModes: Story = {
  args: { initial: "Compact", options: ["Comfortable", "Compact", "Only to check"] },
};
