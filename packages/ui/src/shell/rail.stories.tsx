import type { Meta, StoryObj } from "@storybook/react-vite";
import { Rail } from "./rail";
import { StoryRail } from "./story-rail";

/**
 * **What:** the app's places in a 44 px column at the far left: Studies,
 * Workflows, and Settings at the foot. **Why:** one way between the app's places on every page,
 * without taking room from the panels. **Where:** `AppShell`'s `rail`, built in `SignedIn`.
 *
 * Icons only; each names itself in a tooltip (hover or focus) and to screen readers. The place
 * you are in is pressed, with a bar at the edge. Settings opens a popover in the app (theme and
 * account). A guest also sees a Sign in icon above Settings, so it is found without opening
 * Settings.
 */
const meta = {
  title: "Shell/Rail",
  component: Rail,
  args: { children: null },
  decorators: [(Story) => <div className="flex h-80 border border-border">{Story()}</div>],
} satisfies Meta<typeof Rail>;
export default meta;
type Story = StoryObj<typeof meta>;

export const InStudies: Story = { render: () => <StoryRail /> };
export const InWorkflows: Story = { render: () => <StoryRail place="workflows" /> };
export const Guest: Story = { render: () => <StoryRail guest /> };
