import type { Meta, StoryObj } from "@storybook/react-vite";
import { Breadcrumb } from "./breadcrumb";

/**
 * **What:** where you are, in the header line: the places above this screen as links, then this
 * screen. **Why:** nested pages retain study context without duplicating global navigation.
 * **Where:** study, sample and New study screens through `ShellHeading`; top-level pages omit it.
 */
const meta = {
  title: "Shell/Breadcrumb",
  component: Breadcrumb,
  args: {
    trail: [{ label: "Studies", to: "#studies" }],
    current: "OA7 DMM vs Sham",
  },
} satisfies Meta<typeof Breadcrumb>;
export default meta;
type Story = StoryObj<typeof meta>;

export const StudyPage: Story = {};
export const Sample: Story = {
  args: {
    trail: [
      { label: "Studies", to: "#studies" },
      { label: "DMM pilot, week 8", to: "#study" },
    ],
    current: "OA6-1RK",
  },
};
export const LongContext: Story = {
  args: {
    trail: [
      { label: "Studies", to: "#studies" },
      {
        label: "DMM pilot, week 8 — longitudinal osteoarthritis study with a long descriptive name",
        to: "#study",
      },
    ],
    current: "Compare",
  },
};
