import type { Meta, StoryObj } from "@storybook/react-vite";
import { Crosshair } from "lucide-react";
import { Chip } from "./chip";

/**
 * **What:** a short mono tag. **Why:** facts the AI sees and short labels look the same
 * everywhere, apart from status (that is `StatusMark`). **Where:** the AI panel's "The AI sees"
 * line, attachments in messages ("coronal 211", your marks), attempt labels, "after Nov 4".
 */
const meta = {
  title: "Parts/Chip",
  component: Chip,
  args: { children: "OA7-2" },
} satisfies Meta<typeof Chip>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Plain: Story = {};
export const Attempt: Story = { args: { children: "Attempt 2" } };
export const WithIcon: Story = {
  args: {
    children: (
      <>
        <Crosshair /> coronal 211
      </>
    ),
  },
};
/** Several in a line, as "The AI sees" shows them. */
export const InALine: Story = {
  render: () => (
    <div className="flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground">
      The AI sees
      <Chip>OA7-2</Chip>
      <Chip>coronal 211</Chip>
      <Chip>P1</Chip>
      <Chip>R1 0.412 mm</Chip>
    </div>
  ),
};
