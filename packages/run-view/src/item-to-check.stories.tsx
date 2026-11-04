import type { Meta, StoryObj } from "@storybook/react-vite";
import { Button } from "@voluma/ui";
import { Crosshair } from "lucide-react";
import { ItemToCheck } from "./item-to-check";

/**
 * **What:** one To check item waiting for your decision: what the AI asks you to check, what to
 * look at, and Looks right with what it commits to. **Why:** the decision lives in one place; other places refer to the item
 * instead of drawing it again. **Where:** the input review's output report.
 *
 * Sample data (stories only).
 */
const meta = {
  title: "Run view/ItemToCheck",
  component: ItemToCheck,
  decorators: [(Story) => <div className="w-[368px]">{Story()}</div>],
  args: {
    context: "The AI asks you to check this result",
    title:
      "The osteophyte merges with the medial femoral condyle; the label edge is the AI's best call.",
    state: "open",
    onAccept: () => {},
  },
} satisfies Meta<typeof ItemToCheck>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Open: Story = {};
export const Saving: Story = { args: { accepting: true } };
export const Accepted: Story = { args: { state: "accepted" } };
/** An example run takes no decisions: the reason sits beside the off button. */
export const ReadOnly: Story = {
  args: { onAccept: undefined, readOnly: "Example runs can't be changed" },
};
/** On an output this one rests on, with the page's own action after the decision. */
export const OnAnInput: Story = {
  args: {
    context: "The AI asks you to check Bone labels, which this rests on",
    title: "Label 9's pieces may belong to the lateral meniscus.",
    actions: (
      <>
        <Button size="sm">Tell the AI what's wrong</Button>
        <Button variant="ghost" size="sm">
          <Crosshair aria-hidden />
          Show
        </Button>
      </>
    ),
  },
};
export const Failed: Story = { args: { error: "This changed since you opened it. Look again." } };
