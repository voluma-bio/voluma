import type { Meta, StoryObj } from "@storybook/react-vite";
import { STATUS_WORD, type Status, StatusGlyph, StatusMark } from "./status-mark";

/**
 * **What:** the state of a task, scan, item, run or agent: one glyph and one word. The glyph's
 * shape carries the state without colour (diamond to check, tick done, turning arc running,
 * turning arc round a tick checking, dashed ring waiting, bars paused, crossed square stopped). **Why:** one
 * name and one look per state; today "waiting" alone has ten names. **Where:** the study panel's
 * scan list, the scans x tasks matrix, task graph boxes, Scans, To check, the scan queue, the
 * agents tree and the header line. A caller may give a more exact word ("2 to check", "Failed")
 * that keeps the state's meaning.
 */
const meta = {
  title: "Parts/StatusMark",
  component: StatusMark,
  args: { status: "check" },
} satisfies Meta<typeof StatusMark>;
export default meta;
type Story = StoryObj<typeof meta>;

const all = Object.keys(STATUS_WORD) as Status[];

/** Every state, with its glyph alone beside it as dense places show it. */
export const AllStates: Story = {
  render: () => (
    <div className="grid w-max grid-cols-[auto_auto] items-center gap-x-6 gap-y-2">
      {all.map((s) => (
        <div key={s} className="contents">
          <StatusMark status={s} />
          <StatusGlyph status={s} />
        </div>
      ))}
    </div>
  ),
};
export const ToCheck: Story = { args: { status: "check" } };
export const ToCheckCounted: Story = { args: { status: "check", label: "2 to check" } };
export const Running: Story = { args: { status: "running" } };
/** A second AI is checking the work. */
export const Checking: Story = { args: { status: "checking" } };
export const Done: Story = { args: { status: "done" } };
export const Waiting: Story = { args: { status: "waiting" } };
export const Paused: Story = { args: { status: "paused", label: "Paused" } };
export const Stopped: Story = { args: { status: "stopped" } };
export const Failed: Story = { args: { status: "stopped", label: "Failed" } };
