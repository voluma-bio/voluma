import type { Meta, StoryObj } from "@storybook/react-vite";
import { Box, ChevronRight, Download, Maximize2, RotateCcw } from "lucide-react";
import { Button, IconButton } from "./button";

/**
 * **What:** a clickable action, in four looks: primary (ink fill), secondary (raised, outlined),
 * ghost (bare until hovered; `aria-pressed` shows it on), at 30 px (`md`) or 24 px (`sm`), and
 * link (underlined text inside a sentence). `asChild` puts the look on a router link or a trigger.
 * `IconButton` is the square, icon-only form; its label is its tooltip and accessible name.
 * **Why:** one look per kind of action, so the main action on a view is always the one
 * ink-filled button, and a disabled action always says why (`reason`). **Where:** every screen:
 * "Looks right" and "Something's wrong" on the item to check, Start on the study page, strip and
 * panel-head icons, the viewer toolbar; links such as "Remove it" and "Try again" in a line of
 * text. Labels say what happens.
 */
const meta = {
  title: "Parts/Button",
  component: Button,
  args: { children: "Looks right" },
} satisfies Meta<typeof Button>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Primary: Story = { args: { variant: "primary", children: "Ask the AI to redo" } };
export const Secondary: Story = {
  args: {
    variant: "secondary",
    children: (
      <>
        <Box /> Review in 3D
      </>
    ),
  },
};
export const Ghost: Story = {
  args: {
    variant: "ghost",
    children: (
      <>
        <Download /> Values (CSV)
      </>
    ),
  },
};
/** A ghost button that toggles something shows it on with `aria-pressed`. */
export const GhostOn: Story = {
  args: { variant: "ghost", "aria-pressed": true, children: "Labels" },
};
export const Small: Story = {
  render: () => (
    <div className="flex items-center gap-2">
      <Button size="sm">Looks right</Button>
      <Button size="sm">
        <RotateCcw /> Try again
      </Button>
      <Button size="sm" variant="primary">
        Start
      </Button>
      <Button size="sm" variant="ghost">
        Run details
      </Button>
    </div>
  ),
};
export const Disabled: Story = {
  render: () => (
    <div className="flex items-center gap-2">
      <Button variant="primary" disabled>
        Start
      </Button>
      <Button disabled>Review in 3D</Button>
      <Button variant="ghost" disabled>
        Values (CSV)
      </Button>
    </div>
  ),
};
/** A disabled action says why beside it, so nobody is left guessing. */
export const DisabledWithReason: Story = {
  args: {
    variant: "primary",
    disabled: true,
    children: "Start",
    reason: "Add your AI key to start a run",
  },
};
/** Hover or focus one to see its tooltip. */
export const IconOnly: Story = {
  render: () => (
    <div className="flex items-center gap-2">
      <IconButton label="Full view" shortcut="F">
        <Maximize2 />
      </IconButton>
      <IconButton label="Next item" shortcut="J" variant="secondary">
        <ChevronRight />
      </IconButton>
      <IconButton label="Next item" size="sm" variant="secondary">
        <ChevronRight />
      </IconButton>
      <IconButton label="Full view" disabled>
        <Maximize2 />
      </IconButton>
    </div>
  ),
};
/** A link sits in a sentence and looks like one, at the sentence's size. */
export const Link: Story = {
  render: () => (
    <p className="m-0 text-sm text-muted-foreground">
      Couldn't load the scans.{" "}
      <Button variant="link" onClick={() => {}}>
        Try again
      </Button>
    </p>
  ),
};
/** `asChild` gives the look to the one child, here an anchor (a router `Link` in the app). */
export const AsChild: Story = {
  render: () => (
    <Button asChild size="sm">
      <a href="#review">Open in 3D</a>
    </Button>
  ),
};
