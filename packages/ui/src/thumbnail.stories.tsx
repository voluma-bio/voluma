import type { Meta, StoryObj } from "@storybook/react-vite";
import { StatusGlyph } from "./status-mark";
import { Thumbnail } from "./thumbnail";

/** A small test picture, a data URL so the story needs no server. */
const PICTURE = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40" fill="#14181d"/><path d="M14 4h12l-2 14 4 18H12l4-18z" fill="#c9ced6"/></svg>',
)}`;

/**
 * **What:** a square picture of a sample. **Why:** samples are told apart by what they look
 * like before their names are read. **Where:** the study's sample rows and the Studies details
 * pane. A sample with no picture yet, or one that fails to load, gets a plain tile.
 */
const meta = {
  title: "Parts/Thumbnail",
  component: Thumbnail,
  args: { src: PICTURE },
} satisfies Meta<typeof Thumbnail>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Picture: Story = {};
/** No run has made one yet. */
export const NoPictureYet: Story = { args: { src: undefined } };
/** The picture's address answers with an error. */
export const FailedToLoad: Story = { args: { src: "/missing-thumbnail.webp" } };
export const WithMark: Story = {
  args: { size: 36, mark: <StatusGlyph status="check" className="size-3" /> },
};
