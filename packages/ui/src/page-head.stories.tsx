import type { Meta, StoryObj } from "@storybook/react-vite";
import { Box as Cube, Download } from "lucide-react";
import { Button } from "./button";
import { Count } from "./count";
import { PageHead } from "./page-head";

/**
 * **What:** the head of a page in the main area: title, a Count when the page is a list, facts
 * about what it shows, and the page's actions. **Why:** every study page and Home open the same
 * way, so the eye finds the title and the one primary action in the same place. **Where:** Home,
 * Run on new scans, Workflows, and each study page (Dashboard, To check, Scans, Results, Details).
 */
const meta = {
  title: "Parts/PageHead",
  component: PageHead,
  parameters: { layout: "fullscreen" },
  args: {
    title: "OA7 DMM vs Sham",
    subtitle: "10 DMM, left knees. 10 Sham, right knees. Mouse OA knee",
    actions: (
      <>
        <Button>
          <Download aria-hidden />
          Export values
        </Button>
        <Button variant="primary">
          <Cube aria-hidden />
          Review OA7-2
        </Button>
      </>
    ),
  },
} satisfies Meta<typeof PageHead>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Study: Story = {};
/** A list page: the title carries its count. */
export const WithCount: Story = {
  args: {
    title: "To check",
    count: <Count tone="check">18</Count>,
    subtitle: "18 items across 7 scans",
    actions: <Button variant="primary">Review OA7-2</Button>,
  },
};
/** No actions, no facts: the title alone. */
export const TitleOnly: Story = {
  args: { title: "Workflows", subtitle: undefined, actions: undefined },
};
