import type { Meta, StoryObj } from "@storybook/react-vite";
import { Button } from "./button";

/**
 * **What:** a clickable action. **Why:** one look per kind of action, so the main action on a
 * view is always the one ink-filled button. **Where:** every screen; `buttonClass` gives a router
 * link the same look. Labels say what happens ("Looks right", "Start"); a disabled button says
 * why beside it.
 */
const meta = {
  title: "Parts/Button",
  component: Button,
  args: { children: "Looks right" },
} satisfies Meta<typeof Button>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Primary: Story = { args: { variant: "primary" } };
export const Quiet: Story = { args: { variant: "quiet", children: "Something's wrong" } };
export const Ghost: Story = { args: { variant: "ghost", children: "Run details" } };
export const Disabled: Story = { args: { variant: "primary", disabled: true, children: "Start" } };
