import type { Meta, StoryObj } from "@storybook/react-vite";
import { List, RowLink } from "./row";
import { StatusMark } from "./status-mark";

/**
 * **What:** a row that is a place. The whole row navigates (an arrow shows on hover); its chevron
 * still opens the next layer in place. **Why:** lists of scans and tasks you go into were ad hoc
 * links; this keeps them one row. **Where:** Home's "Needs you" and "Your studies", the study
 * panel's scans, Scans rows, Box bodies.
 *
 * `to` takes a URL, or a function that renders your router's link with the props it is given
 * (`to={(p) => <Link to={path} {...p} />}`), so this package needs no router.
 */
const meta = {
  title: "Parts/RowLink",
  component: RowLink,
  args: {
    title: "OA7 DMM vs Sham",
    subtitle: "18 to check across 7 scans",
    to: "#study",
    cells: [
      <span key="n" className="text-sm text-check">
        18 to check
      </span>,
    ],
  },
  render: (args) => (
    <List columns="110px" boxed>
      <RowLink {...args} />
      <RowLink
        title="OA7-6, left knee"
        subtitle="Tibial IIOC, task 4 of 9"
        to="#scan"
        cells={[<StatusMark key="s" status="running" label="Task 4 of 9" />]}
      />
    </List>
  ),
} satisfies Meta<typeof RowLink>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Hover a row for its arrow; the chevron opens the first one in place without navigating. */
export const WithNextLayer: Story = {
  args: { children: <p className="m-0 text-sm text-fg-subtle">The scans that need you.</p> },
};

export const Open: Story = {
  args: {
    defaultOpen: true,
    children: <p className="m-0 text-sm text-fg-subtle">The scans that need you.</p>,
  },
};

/** Only goes somewhere: no chevron. */
export const PlaceOnly: Story = {};

/** Rendered through a router's link instead of a plain `<a>`. */
export const RouterLink: Story = {
  args: {
    to: (props) => <a href="#from-router" data-router="" {...props} />,
  },
};

/** A subtitle that is a sentence to read whole wraps instead of being cut: Home's "Needs you". */
export const WrappedSubtitle: Story = {
  args: {
    subtitle:
      "18 to check across 8 scans. 2 scans failed: OA7-15, OA7-20. 1 scan paused until you add your API key.",
    wrapSubtitle: true,
  },
};
