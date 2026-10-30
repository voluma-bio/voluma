import type { Meta, StoryObj } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Button } from "@voluma/ui";
import { Box as Cube } from "lucide-react";
import { ItemToCheck } from "./item-to-check";

/**
 * **What:** one open check on one scan's result: what the AI flagged, where, why, and the
 * decision ("Looks right"). **Why:** a decision lives in one place, and accepting reads and fails
 * the same wherever it is offered. **Where:** the study's To check page (under a scan or an issue)
 * and the scan review's To check panel.
 *
 * Sample data (stories only). There is no API here, so "Looks right" fails and shows its error.
 */
const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });

const meta = {
  title: "Run view/ItemToCheck",
  component: ItemToCheck,
  args: {
    runId: "sample-run",
    revisionId: "sample-revision",
    taskId: "segmentation",
    checkId: "medial-osteophyte",
    title: "Medial osteophyte boundary",
    context: "Segmentation",
    detail:
      "The osteophyte merges with the medial femoral condyle; the label edge is the AI's best call.",
    children: (
      <Button size="sm">
        <Cube aria-hidden />
        Review in 3D
      </Button>
    ),
  },
  decorators: [
    (Story) => (
      <QueryClientProvider client={client}>
        <div className="max-w-xl px-4">{Story()}</div>
      </QueryClientProvider>
    ),
  ],
} satisfies Meta<typeof ItemToCheck>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Under its scan: named by the check, with its task. */
export const UnderAScan: Story = {};
/** Under its issue (one check across scans): named by the scan. */
export const UnderAnIssue: Story = { args: { title: "OA7-2, left knee", context: undefined } };
/** With the value it affects. */
export const WithValue: Story = {
  args: { values: [{ label: "Medial osteophyte volume", value: "0.500", unit: "mm³" }] },
};
/** An example study is read-only: the decision says why it is off. */
export const ReadOnly: Story = { args: { readOnly: true } };
