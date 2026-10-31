import type { Meta, StoryObj } from "@storybook/react-vite";
import { Button, Readout } from "@voluma/ui";
import { Box } from "lucide-react";
import { ItemToCheck } from "./item-to-check";

/**
 * **What:** one item waiting for your decision: its task, what the AI says, what the second AI
 * check found, the value it affects, and Looks right / Something's wrong. **Why:** the decision
 * lives in one place; the AI panel and the report refer to the item instead of drawing it again.
 * **Where:** the scan review's To check panel and the study's To check page.
 *
 * Sample data (stories only).
 */
const meta = {
  title: "Run view/ItemToCheck",
  component: ItemToCheck,
  decorators: [(Story) => <div className="w-[368px]">{Story()}</div>],
  args: {
    context: "Segmentation",
    title: "Medial osteophyte boundary",
    text: "The osteophyte merges with the medial femoral condyle; the label edge is the AI's best call.",
    found: "A second AI check agreed with the values and left this call to you.",
    value: (
      <Readout
        values={[{ label: "Medial meniscus/osteophyte volume", value: "0.500", unit: "mm³" }]}
      />
    ),
    state: "open",
    onAccept: () => {},
    onWrong: () => {},
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
/** A task left To check with nothing to accept: only Something's wrong. */
export const NothingToAccept: Story = {
  args: {
    context: "Tibial cortical thickness",
    title: "Sent back by the second AI",
    text: "The cortex is thinner than the scan supports at the medial edge.",
    found: undefined,
    value: undefined,
    state: "info",
  },
};
/** On the study's To check page, by issue: the scan above the title, and a way into the scan review. */
export const OnTheStudyPage: Story = {
  args: {
    context: "OA7-2, right knee",
    onWrong: undefined,
    actions: (
      <Button variant="ghost">
        <Box aria-hidden />
        Review OA7-2 in 3D
      </Button>
    ),
  },
};
export const Failed: Story = { args: { error: "This changed since you opened it. Look again." } };
