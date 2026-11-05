import type { Meta, StoryObj } from "@storybook/react-vite";
import { Rail } from "./rail";
import { StoryRail } from "./story-rail";

/**
 * **What:** a 44 px vertical rail: Studies and Workflows above, Settings and Account at the
 * foot, all icon-only with accessible names and hover/focus tooltips. **Why:** navigation stays
 * quiet without losing named destinations or adding a duplicate horizontal bar.
 * **Where:** every screen's AppShell. Settings holds theme; Account holds Sign in (a guest) or
 * Sign out (a member). Both actions open popovers; Escape restores trigger focus.
 */
const meta = {
  title: "Shell/Rail",
  component: Rail,
  args: { brand: null, children: null },
  decorators: [(Story) => <div className="flex h-80 border border-border">{Story()}</div>],
} satisfies Meta<typeof Rail>;
export default meta;
type Story = StoryObj<typeof meta>;

export const MemberLight: Story = {
  globals: { theme: "light" },
  render: () => <StoryRail />,
};
export const MemberDark: Story = {
  globals: { theme: "dark" },
  render: () => <StoryRail />,
};
export const GuestLight: Story = {
  globals: { theme: "light" },
  render: () => <StoryRail guest />,
};
export const GuestDark: Story = {
  globals: { theme: "dark" },
  render: () => <StoryRail guest />,
};
export const Workflows: Story = { render: () => <StoryRail place="workflows" /> };
