import type { Meta, StoryObj } from "@storybook/react-vite";
import { Download } from "lucide-react";
import { Button } from "./button";
import { Popover } from "./popover";

/**
 * **What:** facts about a thing, one click away. Escape or a click outside closes it.
 * **Why:** detail without leaving the page, in place of four hand-rolled popovers. **Where:**
 * Run details, a scan's facts, Study details, matrix hover.
 */
const facts: [string, string, boolean?][] = [
  ["Scan file", "OA7-4LK.ISQ", true],
  ["Scanner", "Scanco vivaCT 40"],
  ["Size", "870 × 512 × 512 at 10.5 µm", true],
  ["Workflow", "Mouse OA knee, 28 Oct"],
  ["Took", "52 min"],
  ["Run id", "8f3c21a0", true],
];

const runDetails = (
  <>
    <dl className="m-0 grid grid-cols-[110px_1fr] gap-x-4 gap-y-1.5 text-sm">
      {facts.map(([k, v, mono]) => (
        <div key={k} className="contents">
          <dt className="text-fg-subtle">{k}</dt>
          <dd className={mono ? "m-0 font-mono text-xs leading-[18px]" : "m-0"}>{v}</dd>
        </div>
      ))}
    </dl>
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
