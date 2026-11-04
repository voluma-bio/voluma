import type { Meta, StoryObj } from "@storybook/react-vite";
import { Box } from "lucide-react";
import { Breadcrumb } from "../breadcrumb";
import { Button } from "../button";
import { PageHead } from "../page-head";
import { StatusMark } from "../status-mark";
import { AppShell, ShellHeading } from "./shell";
import { StoryRail } from "./story-rail";

/**
 * **What:** the one frame every screen sits in: a vertical rail, nested-page context, the main
 * area. **Why:** moving between the study and an input keeps the frame still; only the content
 * changes. **Where:** every signed-in screen (`SignedIn`). Screens lay out their own sides with
 * `SidePanel` (Shell/SidePanel). Pane expansion belongs to the viewer, not the header; Escape
 * leaves it only from the workspace, never from unrelated account controls.
 */
const meta = {
  title: "Shell/AppShell",
  component: AppShell,
  parameters: { layout: "fullscreen" },
  args: { theme: "light", rail: null, children: null },
} satisfies Meta<typeof AppShell>;
export default meta;
type Story = StoryObj<typeof meta>;

function Frame({
  theme,
  guest = false,
  home = false,
}: {
  theme: "light" | "dark";
  guest?: boolean;
  home?: boolean;
}) {
  return (
    <AppShell theme={theme} rail={<StoryRail guest={guest} />}>
      {home ? (
        <PageHead title="Studies" />
      ) : (
        <>
          <ShellHeading>
            <Breadcrumb
              trail={[
                { label: "Studies", to: "#studies" },
                { label: "DMM pilot, week 8 — long study context stays readable", to: "#study" },
              ]}
              current="OA7-2LK"
            />
          </ShellHeading>
          <PageHead
            inline
            title="OA7-2LK"
            subtitle={
              <div className="flex flex-wrap items-center gap-4">
                <span>Group: DMM</span>
                <StatusMark status="done" label="Run finished" />
                <StatusMark status="check" label="5 to check" />
              </div>
            }
            actions={<Button size="sm">Run details</Button>}
          />
        </>
      )}
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
export const GuestLight: Story = {
  globals: { theme: "light" },
  render: () => <Frame theme="light" guest />,
};
export const GuestDark: Story = {
  globals: { theme: "dark" },
  render: () => <Frame theme="dark" guest />,
};

export const HomeLight: Story = {
  globals: { theme: "light" },
  render: () => <Frame theme="light" guest home />,
};
export const HomeDark: Story = {
  globals: { theme: "dark" },
  render: () => <Frame theme="dark" guest home />,
};
