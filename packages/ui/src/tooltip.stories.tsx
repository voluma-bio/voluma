import type { Meta, StoryObj } from "@storybook/react-vite";
import { Maximize2 } from "lucide-react";
import { Button } from "./button";
import { Tooltip } from "./tooltip";

/**
 * **What:** a control's name and its shortcut key, on hover or keyboard focus. **Why:** an icon
 * button has no words of its own, and the keys are learned where they are used. **Where:** every
 * icon button (`IconButton` adds one itself): the strips, panel heads, the viewer toolbar. It
 * renders over the page, clear of any panel that clips.
 */
const meta = {
  title: "Parts/Tooltip",
  component: Tooltip,
  args: {
    label: "Full view",
    shortcut: "F",
    children: (
      <Button aria-label="Full view">
        <Maximize2 />
      </Button>
    ),
  },
  decorators: [(Story) => <div className="pt-12">{Story()}</div>],
} satisfies Meta<typeof Tooltip>;
export default meta;
type Story = StoryObj<typeof meta>;

export const WithShortcut: Story = {};
export const NameOnly: Story = { args: { shortcut: undefined, label: "Run details" } };
export const Below: Story = { args: { side: "bottom" } };
