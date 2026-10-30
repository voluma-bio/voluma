import type { Meta, StoryObj } from "@storybook/react-vite";
import { Progress } from "./progress";
import type { Status } from "./status-mark";

/**
 * **What:** how far along a set of tasks or scans is, and where it's stuck: one cell per task or
 * scan coloured by its state (`cells`), or the same states summed into a thin bar (`bar`) when
 * there are too many to draw. **Why:** one progress look (today there are three hand-rolled
 * bars). **Where:** the study panel header, the study summary, task graph boxes at study size,
 * scan rows and Home's study cards.
 */
const meta = {
  title: "Parts/Progress",
  component: Progress,
  args: { states: [] },
} satisfies Meta<typeof Progress>;
export default meta;
type Story = StoryObj<typeof meta>;

const repeat = (s: Status, n: number): Status[] => Array.from({ length: n }, () => s);
const study: Status[] = [
  ...repeat("done", 4),
  ...repeat("check", 7),
  ...repeat("running", 2),
  ...repeat("stopped", 2),
  ...repeat("waiting", 5),
];

/** One scan's tasks, in task order. */
export const Tasks: Story = {
  args: {
    states: [
      "done",
      "done",
      "check",
      "done",
      "running",
      "running",
      "waiting",
      "waiting",
      "waiting",
    ],
  },
};
/** A study of 20 scans, one cell each. */
export const StudyCells: Story = { args: { states: study, label: "11 of 20" } };
export const StudyBar: Story = {
  args: { states: study, look: "bar", label: "11 of 20" },
  decorators: [(Story) => <div className="w-64">{Story()}</div>],
};
export const AllDone: Story = {
  args: { states: repeat("done", 9), label: "9 of 9" },
};
export const PausedAndChecking: Story = {
  args: { states: ["done", "checking", "done", "paused", "waiting", "waiting"] },
};
export const NothingYet: Story = {
  args: { states: repeat("waiting", 20), look: "bar", label: "0 of 20" },
  decorators: [(Story) => <div className="w-64">{Story()}</div>],
};
