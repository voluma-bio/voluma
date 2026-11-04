import type { Meta, StoryObj } from "@storybook/react-vite";
import { Box, ListTree, MessageSquare } from "lucide-react";
import { useState } from "react";
import { SampleTree } from "../sample-tree";
import { INPUT_WORD } from "../words";
import { AppShell } from "./shell";
import { SidePanel } from "./side-panel";
import { StoryRail } from "./story-rail";

/**
 * **What:** a screen's side panel, one per side: tabs (the left side) or a title with tools (the
 * right side), a seam to resize it, and a fold button. **Why:** the input and the study share one
 * frame whose sides keep their width across pages. **Where:** the input page (Conversation and
 * Scans; Final outputs) and the study pages.
 *
 * Try: drag a seam (or focus it and use the arrow keys); Hide folds a named panel;
 * a folded side is a 28 px strip with a visible Show action and badge, and its content stays
 * mounted. Widths are kept in localStorage (`voluma.sides`).
 */
const meta = {
  title: "Shell/SidePanel",
  component: SidePanel,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof SidePanel>;
export default meta;
type Story = StoryObj<typeof meta>;

function Page({ theme, waiting }: { theme: "light" | "dark"; waiting?: boolean }) {
  const [tab, setTab] = useState(waiting ? "samples" : "conversation");
  return (
    <AppShell theme={theme} rail={<StoryRail />}>
      <div className="flex min-h-0 flex-1">
        <SidePanel
          side="left"
          tab={tab}
          onTabChange={setTab}
          tabs={[
            {
              id: "conversation",
              label: "Conversation",
              icon: <MessageSquare />,
              badge: waiting ? 1 : undefined,
              badgeLabel: "main is waiting on you",
              content: (
                <div className="p-3 text-sm">
                  <textarea
                    aria-label="Draft"
                    defaultValue="A draft that survives a fold"
                    className="w-full rounded-md border border-input bg-card p-2"
                  />
                </div>
              ),
            },
            {
              id: "samples",
              label: INPUT_WORD.Many,
              icon: <ListTree />,
              content: (
                <SampleTree
                  studyId="oa6"
                  sampleId="r1"
                  studies={[
                    {
                      id: "oa6",
                      name: "OA6 and OA7 knees",
                      samples: [
                        {
                          id: "r1",
                          name: "OA6-1RK",
                          group: "needs-you",
                          status: "check",
                          meta: "12 to check",
                          href: "#",
                        },
                        { id: "r2", name: "OA6-2RK", group: "done", status: "done", href: "#" },
                      ],
                    },
                  ]}
                />
              ),
            },
          ]}
        />
        <div className="grid flex-1 place-items-center bg-[var(--viewer-well)] text-[var(--viewer-chip-fg)]">
          <span className="flex items-center gap-2">
            <Box className="size-4" /> The centre
          </span>
        </div>
        <SidePanel
          side="right"
          title="Final outputs"
          meta="1 of 2 in"
          icon={null}
          badge={12}
          badgeLabel="12 need you"
        >
          <p className="m-0 p-3 text-muted-foreground text-sm">What the centre shows, in detail.</p>
        </SidePanel>
      </div>
    </AppShell>
  );
}

export const Light: Story = {
  globals: { theme: "light" },
  args: { side: "right", title: "", icon: null, children: null },
  render: () => <Page theme="light" />,
};
export const DarkWithBadge: Story = {
  globals: { theme: "dark" },
  args: { side: "right", title: "", icon: null, children: null },
  render: () => <Page theme="dark" waiting />,
};

export const FoldedLight: Story = {
  ...Light,
  play: async ({ canvasElement }) => {
    for (const button of canvasElement.querySelectorAll<HTMLButtonElement>(
      'button[aria-label^="Hide "]',
    )) {
      button.click();
    }
  },
};

export const FoldedDark: Story = {
  ...DarkWithBadge,
  play: FoldedLight.play,
};
