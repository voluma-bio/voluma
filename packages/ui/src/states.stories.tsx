import type { Meta, StoryObj } from "@storybook/react-vite";
import { EmptyState, ErrorState, LoadingState } from "./states";

/**
 * **What:** what a list or panel shows instead of rows. Empty says what will fill it; Loading
 * keeps the rows' shapes so nothing jumps when they arrive; Error says what happened, what is
 * safe, and offers a retry. **Why:** one pattern each, in place of twelve empties and seven
 * loadings. **Where:** every list and panel. The error's mark stands in for the Stopped
 * StatusMark until it lands.
 */
const meta = {
  title: "Parts/States",
  component: EmptyState,
  args: { title: "Nothing to check yet", children: "Items appear as each scan's run finishes." },
  decorators: [
    (Story) => (
      <div className="max-w-xl overflow-hidden rounded-lg border border-border">{Story()}</div>
    ),
  ],
} satisfies Meta<typeof EmptyState>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Empty: Story = {};
export const Loading: Story = { render: () => <LoadingState label="Loading scans" /> };
export const LoadingCompact: Story = {
  render: () => <LoadingState rows={5} density="compact" label="Loading scans" />,
};
export const ErrorWithRetry: Story = {
  render: () => (
    <ErrorState title="Couldn't load the slices" onRetry={() => {}}>
      The scan file didn't answer. Your checks so far are saved.
    </ErrorState>
  ),
};
/** Without `onRetry` when there is nothing to retry. */
export const ErrorOnly: Story = {
  render: () => (
    <ErrorState title="OA7-20 stopped during Orientation">
      The AI couldn't reach its provider.
    </ErrorState>
  ),
};
