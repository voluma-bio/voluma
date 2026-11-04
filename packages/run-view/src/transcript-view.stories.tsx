import type { Meta, StoryObj } from "@storybook/react-vite";
import { TranscriptView } from "./transcript-view";

/**
 * **What:** one agent's thread: its prose in the open; its reasoning and runs of tool calls
 * folded closed under a short label; what it was told folded under a label; a failure shown; a
 * live line while it works. **Why:** a researcher checks what an agent did by reading its thread,
 * and a long one stays usable only if the detail waits behind a fold. **Where:** the agents view
 * of the outputs review.
 *
 * Sample data (stories only).
 */
const meta = {
  title: "Run view/TranscriptView",
  component: TranscriptView,
  decorators: [(Story) => <div className="w-[520px]">{Story()}</div>],
  args: {
    empty: "It wrote nothing.",
    links: { names: new Set(["tibia-roi"]), open: () => {} },
    live: "Read tibia-roi/notes.md",
    rows: [
      { kind: "brief", id: "b", label: "Brief", text: "Segment the tibia and report its volume." },
      {
        kind: "process",
        id: "p1",
        digest: "Ran 2 commands, read 1 file",
        steps: [
          { kind: "reasoning", id: "r", text: "Start from the **scan's** header." },
          {
            kind: "tool",
            id: "t1",
            name: "bash",
            title: "python3 inspect.py scan.nii.gz",
            input: { command: "python3 inspect.py scan.nii.gz" },
            status: "done",
            output: "shape (512, 512, 400)",
          },
          {
            kind: "tool",
            id: "t2",
            name: "start_worker",
            title: "Started worker",
            target: "tibia-roi",
            input: { name: "tibia-roi", brief: "Crop the tibia." },
            status: "running",
          },
        ],
      },
      {
        kind: "prose",
        id: "m",
        text: "The scan is 512 × 512 × 400. I started `tibia-roi` on the crop.",
      },
      { kind: "divider", id: "d", text: "main.2" },
      { kind: "failure", id: "f", text: "The model call failed." },
    ],
  },
} satisfies Meta<typeof TranscriptView>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Working: Story = {};
export const Finished: Story = { args: { live: null } };
export const Empty: Story = { args: { rows: [], live: null } };
