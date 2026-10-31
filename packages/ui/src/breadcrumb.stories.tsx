import type { Meta, StoryObj } from "@storybook/react-vite";
import { Breadcrumb } from "./breadcrumb";

/**
 * **What:** where you are, in the header line: the places above this screen as links, then this
 * screen. **Why:** one line answers "where am I" on every screen, so pages need no back buttons.
 * **Where:** every signed-in screen, through `ShellHeading`.
 */
const meta = {
  title: "Shell/Breadcrumb",
  component: Breadcrumb,
  args: {
    trail: [{ label: "OA7 DMM vs Sham", to: "#" }],
    current: "To check",
  },
} satisfies Meta<typeof Breadcrumb>;
export default meta;
type Story = StoryObj<typeof meta>;

export const StudyPage: Story = {};
export const Home: Story = { args: { trail: [], current: "Home" } };
