import type { Meta, StoryObj } from "@storybook/react-vite";
import { ApprovalCard } from "./approval-card";

/**
 * **What:** a call the run's main AI holds for your yes: what it would do and what it makes out
 * of date, Yes and No with your own words, then your answer and how the call ended. **Why:** in
 * review nothing changes a result without the researcher's yes, and the yes is given in the
 * conversation, never by a button outside it. **Where:** the outputs review's conversation.
 *
 * Sample data (stories only).
 */
const meta = {
  title: "Run view/ApprovalCard",
  component: ApprovalCard,
  decorators: [(Story) => <div className="w-[288px]">{Story()}</div>],
  args: {
    title: "Start a worker",
    summary: "Start worker `roi3-face-2` from `roi3-worker` for growth-plate-distal-face.",
    changes: ["Growth plate distal face"],
    outOfDate: ["ROI-3", "Cortex 100", "Cortex 1000", "BV/TV", "Tb.Th"],
    yes: "Yes, start roi3-face-2",
    onAnswer: () => {},
  },
} satisfies Meta<typeof ApprovalCard>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Waiting: Story = {};
/** A request from before the run named what it makes out of date: the summary alone says it. */
export const SummaryOnly: Story = {
  args: {
    summary:
      "Start worker `roi3-face-2` from `roi3-worker` for growth-plate-distal-face. This makes out of date: roi-3, cortex-100, cortex-1000, 8 values.",
    changes: undefined,
    outOfDate: undefined,
  },
};
export const Saving: Story = { args: { pending: "yes" } };
export const Failed: Story = {
  args: { error: "The AI no longer asks this. Reload to see where it stands." },
};
/** An example run takes no answers: the reason sits beside the off buttons. */
export const ReadOnly: Story = {
  args: { onAnswer: undefined, readOnly: "Example runs can't be changed." },
};
/** Answered yes; the call is running. */
export const Answered: Story = { args: { answer: { answer: "yes", time: "19:44" } } };
export const Done: Story = {
  args: {
    answer: { answer: "yes", time: "19:44" },
    settled: "done",
  },
};
/** No is final: no outcome follows, and nothing counts it as open. */
export const Declined: Story = {
  args: {
    answer: { answer: "no", text: "Keep the face as it is; look at V=200 first.", time: "19:44" },
  },
};
/** Refused when it ran: a file it named changed since the question. Main says why. */
export const Refused: Story = {
  args: {
    answer: { answer: "yes", time: "19:44" },
    settled: "refused",
  },
};
/** Main closed the run while it waited: the buttons are gone. */
export const Withdrawn: Story = {
  args: { settled: "withdrawn" },
};
