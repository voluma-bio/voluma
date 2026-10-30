import type { Meta, StoryObj } from "@storybook/react-vite";
import { Readout } from "./readout";

/**
 * **What:** measured values in a sunken well: each a label, its reading in mono and its unit.
 * **Why:** a number looks the same everywhere it appears. **Where:** the item to check, the
 * report panel's values, the view panel's facts, Results, the AI's messages and marks.
 */
const meta = {
  title: "Parts/Readout",
  component: Readout,
  args: { values: [{ label: "Medial meniscus/osteophyte volume", value: "0.500", unit: "mm³" }] },
} satisfies Meta<typeof Readout>;
export default meta;
type Story = StoryObj<typeof meta>;

export const OneValue: Story = { decorators: [(Story) => <div className="w-80">{Story()}</div>] };
export const SeveralValues: Story = {
  args: {
    values: [
      { label: "Bone volume", value: "1.284", unit: "mm³" },
      { label: "Tissue volume", value: "2.917", unit: "mm³" },
      { label: "BV/TV", value: "0.440" },
      { label: "Trabecular thickness", value: "0.061", unit: "mm" },
    ],
  },
  decorators: [(Story) => <div className="w-80">{Story()}</div>],
};
/** A long label truncates; the reading never does. */
export const Narrow: Story = {
  args: {
    values: [{ label: "Medial meniscus/osteophyte volume", value: "0.500", unit: "mm³" }],
  },
  decorators: [(Story) => <div className="w-52">{Story()}</div>],
};
