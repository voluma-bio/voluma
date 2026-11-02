import type { Meta, StoryObj } from "@storybook/react-vite";
import { SampleTree, type TreeSample, type TreeStudy } from "./sample-tree";

/**
 * **What:** the studies and their samples, grouped Needs you, Running and Done, with a search.
 * **Why:** a researcher jumps between samples without leaving review. **Where:** the left side of the
 * study pages, which build it with `sampleTree` (`@voluma/run-view`); the scan page is to show it
 * as a tab. On screen it is called by `INPUT_WORD` ("Samples").
 *
 * Try: type "oa61" (dashes and case don't matter); Up and Down move, Left and Right close and
 * open a branch, Enter opens a sample. Which branches are open is kept across pages.
 */
const meta = {
  title: "Shell/SampleTree",
  component: SampleTree,
  decorators: [(Story) => <div className="w-75 border border-border bg-card">{Story()}</div>],
} satisfies Meta<typeof SampleTree>;
export default meta;
type Story = StoryObj<typeof meta>;

const sample = (
  name: string,
  group: TreeSample["group"],
  status: TreeSample["status"],
  meta?: string,
): TreeSample => ({ id: name, name, group, status, meta, href: `#${name}` });

const studies: TreeStudy[] = [
  {
    id: "oa6",
    name: "OA6 and OA7 knees",
    samples: [
      sample("OA6-1RK", "needs-you", "check", "12 to check"),
      sample("OA7-1L", "needs-you", "stopped", "Failed"),
      sample("OA6-4RK", "running", "running", "Task 3 of 8"),
      sample("OA6-2RK", "done", "done"),
      sample("OA6-3RK", "done", "done"),
      sample("OA7-1R", "done", "done"),
      sample("OA6-1LK", "done", "done"),
    ],
  },
  {
    id: "oa8",
    name: "OA8 aged knees",
    samples: [sample("OA8-1", "running", "waiting", "Waiting")],
  },
  { id: "oa9", name: "OA9 pilot", samples: [sample("OA9-1", "done", "done")] },
];

export const OnAScan: Story = { args: { studies, studyId: "oa6", sampleId: "OA6-1RK" } };
export const OnAStudy: Story = { args: { studies, studyId: "oa8" } };
export const NoSamples: Story = { args: { studies: [] } };
