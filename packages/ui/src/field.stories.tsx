import type { Meta, StoryObj } from "@storybook/react-vite";
import { TextAreaField, TextField } from "./field";

/**
 * **What:** a text input or text area with its label above and, when something is wrong, an
 * error under it. **Why:** one field in place of ad hoc inputs. **Where:** the new-study form,
 * "Something's wrong" notes, the AI composer (label kept for screen readers only).
 */
const meta = {
  title: "Parts/Field",
  component: TextField,
  args: { label: "Study name", placeholder: "OA7 DMM vs Sham" },
  decorators: [(Story) => <div className="grid max-w-sm gap-6">{Story()}</div>],
} satisfies Meta<typeof TextField>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Input: Story = {};
export const Filled: Story = { args: { defaultValue: "OA7 DMM vs Sham" } };
export const WithError: Story = { args: { error: "Give the study a name." } };
export const Disabled: Story = { args: { disabled: true, defaultValue: "OA7 DMM vs Sham" } };

/** The text area grows by dragging its corner. */
export const TextArea: Story = {
  render: () => (
    <TextAreaField
      label="What should be different?"
      placeholder="The osteophyte merges with the condyle"
    />
  ),
};
export const TextAreaWithError: Story = {
  render: () => (
    <TextAreaField label="What should be different?" error="Say what to change before sending." />
  ),
};
/** The AI composer: the box's purpose shows on screen, so the label is for screen readers. */
export const HiddenLabel: Story = {
  render: () => (
    <TextAreaField label="Message to the AI" hideLabel placeholder="Ask about this scan" />
  ),
};
