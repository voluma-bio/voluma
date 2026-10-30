import type { Meta, StoryObj } from "@storybook/react-vite";
import { Camera, LayoutGrid, Rotate3d } from "lucide-react";
import { useState } from "react";
import { Button } from "./button";
import { Menu, MenuHeader, MenuItem, MenuRadioGroup, MenuRadioItem, MenuSeparator } from "./menu";

/**
 * **What:** actions or one choice, opened from a trigger. Arrow keys and type-ahead move,
 * Enter picks, Escape closes. **Why:** one menu in place of ad hoc ones. **Where:** the account
 * menu (the one theme choice), "View from", layout choices.
 */
const meta = {
  title: "Parts/Menu",
  component: Menu,
  args: {
    trigger: <Button variant="ghost">View from</Button>,
    align: "start",
    children: (
      <>
        <MenuItem icon={<Rotate3d />} shortcut="1">
          Front
        </MenuItem>
        <MenuItem icon={<Rotate3d />} shortcut="2">
          Side
        </MenuItem>
        <MenuItem icon={<Rotate3d />} shortcut="3">
          Top
        </MenuItem>
        <MenuSeparator />
        <MenuItem icon={<LayoutGrid />}>Four views</MenuItem>
        <MenuItem icon={<Camera />} disabled>
          Snapshot
        </MenuItem>
      </>
    ),
  },
  decorators: [(Story) => <div className="min-h-80">{Story()}</div>],
} satisfies Meta<typeof Menu>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Actions with icons and keys; a disabled one is skipped by the keyboard. */
export const Actions: Story = {};

function AccountMenu() {
  const [theme, setTheme] = useState("auto");
  return (
    <Menu
      trigger={
        <button
          type="button"
          aria-label="Your account"
          className="grid size-[26px] cursor-pointer place-items-center rounded-full bg-secondary text-xs font-semibold text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          JY
        </button>
      }
      align="start"
      className="w-[300px]"
    >
      <MenuHeader>
        <div className="font-medium">Jimmy Yao</div>
        <div className="text-sm text-fg-subtle">Yao lab</div>
      </MenuHeader>
      <MenuSeparator />
      <MenuRadioGroup label="Appearance" value={theme} onValueChange={setTheme}>
        <MenuRadioItem value="auto" description="Home and study pages light; the 3D review dark">
          Scan review dark, study light
        </MenuRadioItem>
        <MenuRadioItem value="dark" description="Home and study pages dark too">
          Everything dark
        </MenuRadioItem>
      </MenuRadioGroup>
      <MenuSeparator />
      <MenuItem>Account settings</MenuItem>
      <MenuItem>Sign out</MenuItem>
    </Menu>
  );
}

/** The account menu: who you are, the one theme choice, then account actions. */
export const Account: Story = { render: () => <AccountMenu /> };
