import type { Meta, StoryObj } from "@storybook/react-vite";
import { Download } from "lucide-react";
import { Button } from "./button";
import { FactSections, Facts, InfoButton, Popover } from "./popover";

/**
 * **What:** facts about a thing, one click away. Escape or a click outside closes it.
 * **Why:** detail without leaving the page, in place of four hand-rolled popovers. **Where:**
 * Run details, a scan's facts, Study details, matrix hover. `Facts` lays out label and value
 * pairs, `FactSections` several lists under titles. `InfoButton` is the (i) beside an agent, a
 * task or a reply: what it took, tried and cost, which a researcher asks for rather than scans.
 */
const mono = (v: string) => <span className="font-mono text-xs">{v}</span>;
const runDetails = (
  <>
    <Facts
      items={[
        ["Scan file", mono("OA7-4LK.ISQ")],
        ["Scanner", "Scanco vivaCT 40"],
        ["Size", mono("870 × 512 × 512 at 10.5 µm")],
        ["Workflow", "Mouse OA knee, 28 Oct"],
        ["Took", "52 min"],
        ["Run id", mono("8f3c21a0")],
      ]}
    />
    <div className="mt-3 flex gap-2">
      <Button size="sm">
        <Download aria-hidden className="size-3.5" />
        Values (CSV)
      </Button>
      <Button size="sm">
        <Download aria-hidden className="size-3.5" />
        All files
      </Button>
    </div>
  </>
);

const meta = {
  title: "Parts/Popover",
  component: Popover,
  args: {
    trigger: <Button variant="ghost">Run details</Button>,
    children: runDetails,
    label: "Run details",
    align: "start",
  },
  decorators: [(Story) => <div className="min-h-80">{Story()}</div>],
} satisfies Meta<typeof Popover>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Click the trigger to open it. */
export const Closed: Story = {};

/**
 * Shown open. With both themes on screen only one popover stays open at a time (a click in one
 * closes the other); narrow the toolbar to one theme to compare.
 */
export const Open: Story = { args: { open: true } };

/**
 * The (i) beside a thing; click it. Its first section is untitled (the button names it), the
 * model's use sits under the model's name.
 */
export const Info: Story = {
  args: { trigger: <span />, children: null },
  render: () => (
    <InfoButton label="Agent details">
      <FactSections
        sections={[
          {
            items: [
              ["Took", "3 min 4 s"],
              ["Tries", "2"],
              ["Tool calls", "18, 1 failed"],
            ],
          },
          {
            title: "meta/muse-spark-1.3",
            items: [
              ["Cost", "$0.412"],
              ["Command time", "1 min 12 s"],
              ["Model calls", "23"],
            ],
          },
        ]}
      />
    </InfoButton>
  ),
};
