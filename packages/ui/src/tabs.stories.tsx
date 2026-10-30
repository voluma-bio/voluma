import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { TabList, TabPanel, Tabs } from "./tabs";

/**
 * **What:** tabs, each with an optional count; an amber count means items wait for your check.
 * Arrow keys, Home and End move between tabs. **Why:** one tab look inside pages and panels.
 * **Where:** the study page's head (Overview, To check, Scans), tabs inside a panel.
 *
 * `Tabs` holds the state and can wrap the whole page, so the `TabList` and the `TabPanel` sit
 * wherever the layout puts them.
 */
type Id = "overview" | "check" | "scans";

function StudyTabs({ initial = "overview" }: { initial?: Id }) {
  const [tab, setTab] = useState<Id>(initial);
  return (
    <Tabs value={tab} onValueChange={setTab}>
      <TabList<Id>
        label="Study"
        className="border-b border-border"
        tabs={[
          { id: "overview", label: "Overview" },
          { id: "check", label: "To check", count: 18, alert: true },
          { id: "scans", label: "Scans", count: "11/20", countLabel: "11 of 20 done" },
        ]}
      />
      <TabPanel value={tab} className="py-4 text-sm text-fg-subtle">
        {tab === "overview" && "The study's dashboard."}
        {tab === "check" && "Every item waiting for your check."}
        {tab === "scans" && "Every scan in the study."}
      </TabPanel>
    </Tabs>
  );
}

const meta = {
  title: "Parts/Tabs",
  component: StudyTabs,
} satisfies Meta<typeof StudyTabs>;
export default meta;
type Story = StoryObj<typeof meta>;

export const FirstSelected: Story = {};
/** The selected tab carries the underline; counts keep their colour. */
export const CountSelected: Story = { args: { initial: "check" } };
