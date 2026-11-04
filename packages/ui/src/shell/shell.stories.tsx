import type { Meta, StoryObj } from "@storybook/react-vite";
import { Box } from "lucide-react";
import { AppShell, ShellHeading } from "./shell";
import { StoryBrand, StoryRail } from "./story-rail";

/**
 * **What:** the one frame every screen sits in: a header line, the rail at the far left, the main
 * area. **Why:** moving between the study and an input keeps the frame still; only the content
 * changes. **Where:** every signed-in screen (`SignedIn`). Screens lay out their own sides with
 * `SidePanel` (Shell/SidePanel). Pane expansion belongs to the viewer, not the header; Escape
 * leaves it only from the workspace, never from unrelated account controls.
 */
const meta = {
  title: "Shell/AppShell",
  component: AppShell,
  parameters: { layout: "fullscreen" },
  args: { theme: "light", brand: null, rail: null, children: null },
} satisfies Meta<typeof AppShell>;
export default meta;
type Story = StoryObj<typeof meta>;

function Frame({ theme }: { theme: "light" | "dark" }) {
  return (
    <AppShell theme={theme} brand={<StoryBrand />} rail={<StoryRail />}>
      <ShellHeading>
        <span className="text-muted-foreground text-sm">OA7 DMM vs Sham</span>
        <span className="font-medium text-sm">OA7-2, left knee</span>
      </ShellHeading>
      <div className="grid flex-1 place-items-center bg-[var(--viewer-well)] text-[var(--viewer-chip-fg)]">
        <span className="flex items-center gap-2">
          <Box className="size-4" /> The main area
        </span>
      </div>
    </AppShell>
  );
}

export const Light: Story = {
  globals: { theme: "light" },
  render: () => <Frame theme="light" />,
};
export const Dark: Story = {
  globals: { theme: "dark" },
  render: () => <Frame theme="dark" />,
};
