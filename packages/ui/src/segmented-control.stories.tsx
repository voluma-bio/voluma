import type { Meta, StoryObj } from "@storybook/react-vite";
import { Angle, Crosshair, Hand, Lasso, Pipette, Ruler, Spline } from "lucide-react";
import { useState } from "react";
import { SegmentedControl } from "./segmented-control";

/**
 * **What:** a few modes of one view; one is always on. Arrow keys move between them. A mode's
 * key, or why it can't be picked now, shows on hover.
 * **Why:** one look for mode switches that were drawn ad hoc. **Where:** the matrix's Status /
 * Values, a list's Comfortable / Compact, the Agents stream filter, the input review's marking
 * tools (icons with names on hover/focus, with no command shortcuts).
 */
function Demo({
  initial,
  options,
  shortcuts = [],
  reason,
  icons,
}: {
  initial: string;
  options: string[];
  shortcuts?: string[];
  /** Shows these icons instead of the labels. */
  icons?: boolean;
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
        icon: icons ? ICONS[i] : undefined,
      }))}
    />
  );
}

const ICONS = [
  <Hand key="navigate" />,
  <Crosshair key="p" />,
  <Ruler key="l" />,
  <Angle key="a" />,
  <Lasso key="o" />,
  <Spline key="path" />,
  <Pipette key="i" />,
];

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
export const MarkingTools: Story = {
  args: {
    initial: "Navigate",
    options: ["Navigate", "Point", "Ruler", "Angle", "Outline", "Freehand line", "Probe"],
    icons: true,
  },
};
export const Icons: Story = {
  args: {
    ...MarkingTools.args,
  },
};
export const HeldOff: Story = {
  args: {
    ...MarkingTools.args,
    reason: "A message carries up to 20 marks. Delete one to add another.",
  },
};
