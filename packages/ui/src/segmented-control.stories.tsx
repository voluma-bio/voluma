import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { SegmentedControl } from "./segmented-control";

/**
 * **What:** a few modes of one view; one is always on. Arrow keys move between them. A mode's
 * key, or why it can't be picked now, shows on hover.
 * **Why:** one look for mode switches that were drawn ad hoc. **Where:** the matrix's Status /
 * Values, a list's Comfortable / Compact, the Agents stream filter, the scan review's marking
 * tools (each with its key).
 */
function Demo({
  initial,
  options,
  shortcuts = [],
  reason,
}: {
  initial: string;
  options: string[];
  shortcuts?: string[];
  /** Holds every mode but the first off, with this reason. */
  reason?: string;
}) {
  const [value, setValue] = useState(initial);
  return (
    <SegmentedControl
      label="Show"
      value={value}
      onValueChange={setValue}
      options={options.map((o, i) => ({
        value: o,
        label: o,
        shortcut: shortcuts[i],
        reason: i > 0 ? reason : undefined,
      }))}
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
export const WithShortcuts: Story = {
  args: {
    initial: "Navigate",
    options: ["Navigate", "Point", "Box", "Line", "Lasso"],
    shortcuts: ["Escape", "p", "b", "l", "o"],
  },
};
export const HeldOff: Story = {
  args: {
    ...WithShortcuts.args,
    reason: "A message carries up to 20 marks. Delete one to add another.",
  },
};
