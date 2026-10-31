import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { SegmentedControl } from "./segmented-control";

/**
 * **What:** two or three modes of one view; one is always on. Arrow keys move between them.
 * **Why:** one look for mode switches that were drawn ad hoc. **Where:** the matrix's Status /
 * Values, a list's Comfortable / Compact, the Agents stream filter, the scan review's marking
 * tools (each with its key).
 */
function Demo({
  initial,
  options,
  keys = [],
}: {
  initial: string;
  options: string[];
  keys?: string[];
}) {
  const [value, setValue] = useState(initial);
  return (
    <SegmentedControl
      label="Show"
      value={value}
      onValueChange={setValue}
      options={options.map((o, i) => ({ value: o, label: o, keys: keys[i] }))}
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
export const WithKeys: Story = {
  args: {
    initial: "Navigate",
    options: ["Navigate", "Point", "Box", "Line", "Lasso"],
    keys: ["Escape", "P", "B", "L", "O"],
  },
};
