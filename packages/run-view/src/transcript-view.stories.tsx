import type { Meta, StoryObj } from "@storybook/react-vite";
import { TranscriptView } from "./transcript-view";

/**
 * **What:** one agent's thread: its prose in the open, what it told the researcher as "The AI",
 * the calls that change results (a worker started, an output reported) as rows of their own; its
 * reasoning and other runs of tool calls folded closed under its status line and a count; what it
 * was told folded quieter; a failure shown; a live line while it works. **Why:** a researcher
 * checks what the AI did by reading its thread, and a long one stays usable only if the detail
 * waits behind a fold. **Where:** the Conversation (main) and the Agents tab (a worker) of the
 * outputs review.
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
    live: { text: "Cropping the tibia from the scan", words: true },
    slot: (id: string) => (
      <div className="rounded-lg bg-muted px-3 py-2 text-ui">Your message ({id})</div>
    ),
    rows: [
      { kind: "brief", id: "b", label: "The AI's instructions", text: "You run the analysis." },
      {
        kind: "prose",
        id: "m0",
        at: "2026-11-04T17:07:00Z",
        head: true,
        text: "Measuring the tibia, starting with the scan header.",
      },
      {
        kind: "process",
        id: "p1",
        label: "Checking the scan header · ran 1 command",
        steps: [
          { kind: "reasoning", id: "r", text: "Start from the **scan's** header." },
          {
            kind: "tool",
            id: "a1",
            name: "activity",
            title: "Checking the scan header",
            input: { text: "Checking the scan header" },
            status: "done",
          },
          {
            kind: "tool",
            id: "t1",
            name: "bash",
            title: "python3 inspect.py scan.nii.gz",
            input: { command: "python3 inspect.py scan.nii.gz" },
            status: "done",
            output: "shape (512, 512, 400)",
          },
        ],
      },
      {
        kind: "prose",
        id: "s",
        at: "2026-11-04T17:08:00Z",
        text: "I'll crop the tibia first, then segment it.",
      },
      {
        kind: "step",
        id: "w",
        step: {
          kind: "tool",
          id: "w",
          name: "start_worker",
          title: "Started worker",
          target: "tibia-roi",
          input: { name: "tibia-roi", brief: "Crop the tibia from the scan." },
          status: "running",
        },
      },
      {
        kind: "step",
        id: "o",
        step: {
          kind: "tool",
          id: "o",
          name: "report_output",
          title: "Reported Scan, version 1",
          input: { id: "scan" },
          status: "done",
          output: "Published.",
        },
      },
      {
        kind: "slot",
        id: "you",
        got: "The researcher wrote: crop tighter.\nMarks: M1 at (120, 88, 40).",
      },
      {
        kind: "brief",
        id: "n",
        label: "News from the run",
        text: "tibia-roi reported scan version 1.",
      },
      { kind: "failure", id: "f", text: "The model call failed." },
    ],
  },
} satisfies Meta<typeof TranscriptView>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Working: Story = {};
export const Finished: Story = { args: { live: null } };
/** A run in the queue: nothing works yet, so the line does not pulse. */
export const Queued: Story = {
  args: { live: { text: "Waiting to start · place 2 in line", words: true, quiet: true } },
};
export const Empty: Story = { args: { rows: [], live: null } };
/** The Agents tab's live line: the running call's title. */
export const RunningCall: Story = { args: { live: { text: "Read tibia-roi/notes.md" } } };
