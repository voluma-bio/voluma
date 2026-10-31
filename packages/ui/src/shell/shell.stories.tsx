import type { Meta, StoryObj } from "@storybook/react-vite";
import { Bot, Box, Eye, FileText, LayoutDashboard, ListChecks, Ruler, Users } from "lucide-react";
import { useState } from "react";
import { AppShell, ShellHeading, ShellLink, ShellPanel } from "./shell";

/**
 * **What:** the one frame every screen sits in: a header line, an icon strip at each edge, up to
 * two docked panels per side, the main area between. **Why:** moving between the study and a
 * scan keeps the frame still; only the content changes.
 * Panels push the main area, never cover it. **Where:** every signed-in screen (`SignedIn`).
 *
 * Try: click a strip button to open its panel, again to close; Shift-click stacks a second panel;
 * drag a side's inner edge to resize, double-click it to fold; `\` and `]` fold a side; F for Full
 * view, Esc to leave. A screen declares panels with `<ShellPanel>` inside its own tree, and pages
 * with `<ShellLink>`.
 */
const meta = {
  title: "Shell/AppShell",
  component: AppShell,
  parameters: { layout: "fullscreen" },
  args: { theme: "light", logo: <b>Voluma</b>, account: <span>Guest</span>, children: null },
} satisfies Meta<typeof AppShell>;
export default meta;
type Story = StoryObj<typeof meta>;

function Lorem({ what }: { what: string }) {
  return <div className="p-3 text-muted-foreground text-sm">{what}</div>;
}

function Frame({ theme }: { theme: "light" | "dark" }) {
  const [page, setPage] = useState("dashboard");
  return (
    <AppShell theme={theme} logo={<b>Voluma</b>} account={<span className="text-sm">Guest</span>}>
      <ShellHeading>
        <span className="text-muted-foreground text-sm">OA7 DMM vs Sham</span>
        <span className="font-medium text-sm">OA7-2, left knee</span>
      </ShellHeading>
      <ShellLink
        id="s-dash"
        group="study"
        label="Dashboard"
        icon={<LayoutDashboard />}
        active={page === "dashboard"}
        go={() => setPage("dashboard")}
      />
      <ShellLink
        id="s-check"
        group="study"
        label="To check"
        icon={<ListChecks />}
        count={18}
        active={page === "check"}
        go={() => setPage("check")}
      />
      <ShellPanel
        id="s-report"
        side="left"
        group="scan"
        label="Report"
        icon={<FileText />}
        shortcut="t"
        defaultOpen
      >
        <Lorem what="The scan's task graph and the selected task's values." />
      </ShellPanel>
      <ShellPanel
        id="s-agents"
        side="left"
        group="scan"
        label="Agents"
        icon={<Users />}
        shortcut="g"
        minWidth={520}
      >
        <Lorem what="Every agent as a tree, with the selected one's stream." />
      </ShellPanel>
      <ShellPanel id="s-view" side="right" label="View" icon={<Eye />} shortcut="d">
        <Lorem what="Structures with 3D and 2D eyes, window and level." />
      </ShellPanel>
      <ShellPanel id="s-ai" side="right" label="The AI" icon={<Bot />} shortcut="/" defaultOpen>
        <Lorem what="The conversation with the AI." />
      </ShellPanel>
      <ShellPanel id="s-marks" side="right" label="Marks" icon={<Ruler />} count={2} shortcut="m">
        <Lorem what="Your marks and the AI's, by name." />
      </ShellPanel>
      <div className="grid flex-1 place-items-center bg-[var(--viewer-well)] text-[var(--viewer-chip-fg)]">
        <span className="flex items-center gap-2">
          <Box className="size-4" /> The main area: {page}
        </span>
      </div>
    </AppShell>
  );
}

export const StudyLight: Story = {
  globals: { theme: "light" },
  render: () => <Frame theme="light" />,
};
export const ScanReviewDark: Story = {
  globals: { theme: "dark" },
  render: () => <Frame theme="dark" />,
};
