import type { Meta, StoryObj } from "@storybook/react-vite";
import { StripPlot } from "./strip-plot";

/**
 * **What:** one measurement compared across groups of scans: every scan a dot, a tick for each
 * group's mean, and only a scan far from its group in amber with its name. **Why:** groups hold
 * one to eight scans, and a bar or box would hide them. **Where:** the study's Results (one plot
 * per value) and a value's row in the overview. Hover or focus a dot for its value; arrow keys
 * move between dots.
 */
const meta = {
  title: "Parts/StripPlot",
  component: StripPlot,
  args: {
    label: "Medial osteophyte volume",
    unit: "mm³",
    digits: 3,
    onSelect: () => {},
    groups: [
      {
        name: "DMM",
        points: [
          { id: "OA6-1", label: "OA6-1", value: 0.512 },
          { id: "OA6-2", label: "OA6-2", value: 0.47 },
          { id: "OA6-3", label: "OA6-3", value: 0.538 },
          {
            id: "OA7-2",
            label: "OA7-2",
            value: 0.81,
            far: true,
            farReason: "58% above the rest of DMM",
          },
          { id: "OA7-3", label: "OA7-3", value: 0.495 },
          { id: "OA7-4", label: "OA7-4", value: null },
        ],
      },
      {
        name: "Sham",
        points: [
          { id: "OA8-1", label: "OA8-1", value: 0.21 },
          { id: "OA8-2", label: "OA8-2", value: 0.244 },
          { id: "OA8-3", label: "OA8-3", value: 0.198 },
          { id: "OA8-4", label: "OA8-4", value: 0.231, hollow: true },
        ],
      },
    ],
  },
  decorators: [(Story) => <div className="max-w-xl">{Story()}</div>],
} satisfies Meta<typeof StripPlot>;
export default meta;
type Story = StoryObj<typeof meta>;

export const TwoGroups: Story = {};
/** Equal values spread around their place instead of hiding each other. */
export const Grades: Story = {
  args: {
    label: "OARSI grade",
    unit: "grade",
    digits: 0,
    groups: [
      {
        name: "DMM",
        points: [3, 3, 4, 3, 2, 3, 4, 3].map((v, i) => ({
          id: `d${i}`,
          label: `OA6-${i + 1}`,
          value: v,
        })),
      },
      {
        name: "Sham",
        points: [0, 1, 0, 0, 1].map((v, i) => ({ id: `s${i}`, label: `OA8-${i + 1}`, value: v })),
      },
    ],
  },
};
/** No values yet: each group says how many are to come. */
export const NoneYet: Story = {
  args: {
    groups: [
      { name: "DMM", points: [{ id: "a", label: "OA6-1", value: null }] },
      { name: "Sham", points: [{ id: "b", label: "OA8-1", value: null }] },
    ],
  },
};
