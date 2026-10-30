import type { Meta, StoryObj } from "@storybook/react-vite";
import { Disclosure } from "./disclosure";

/**
 * **What:** depth inside a row: a quiet line with a chevron that opens what sits under it.
 * **Why:** one way to expand, in place of nine. **Where:** a task's "How the AI did it" and
 * "Files", an agent's steps, inside open rows and the Report panel.
 */
const meta = {
  title: "Parts/Disclosure",
  component: Disclosure,
  args: {
    label: "Files (6)",
    children: (
      <div className="font-mono text-sm">
        segmentation/labels.nii.gz
        <br />
        segmentation/values.csv
      </div>
    ),
  },
  decorators: [(Story) => <div className="max-w-md">{Story()}</div>],
} satisfies Meta<typeof Disclosure>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Closed: Story = { args: { label: "How the AI did it" } };
export const Open: Story = { args: { defaultOpen: true } };
