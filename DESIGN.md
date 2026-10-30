# Design

Visual rules the code can't show, from the [visual direction][direction].
They are review points, not CI failures. The components live in
`packages/ui`, the tokens in `packages/design-tokens`, and Storybook
(`apps/storybook`) shows each component in both themes with what it is for and
where it is used.

## Two themes, one token set

- **Light** for home and study pages; **dark** for the 3D scan review. The whole app switches,
  the frame included; nothing else differs between the two ("Imaging pro" in the redesign).
- Components use semantic token utilities (`bg-card`, `text-muted-foreground`,
  `border-border`), never raw colours. The names are shadcn/ui's, with our palette as the values;
  `accent` is shadcn's hover fill and `primary` the ink-filled main action. A colour a screen needs goes into
  `tokens.css` with a role name and a value for both themes.
- Type is Instrument Sans, with IBM Plex Mono for values, units and ids. Body is 14px.
  Numbers in columns use tabular figures.

## Status

- **Status lives in the list, never in mesh colour.** Task, run and
  structure status shows as a badge or dot in lists and reports.
- The one exception: the region under check is outlined in amber
  (`--check-outline`) on the slices and in 3D.
- Amber always means To check; violet means running or corrected; green means
  done; red stopped; grey waiting. Ice (`select`) means selection only. Don't reuse them for
  decoration.

## Comparing scans

- **Groups of scans compare as strip plots, not bars** (`StripPlot`): every scan a dot, a tick for the
  group mean. Groups hold 1 to 8 scans, and a bar or box hides them.
- Dots are ink; only a scan far from its group turns amber, with its name beside it. Nothing else
  in a chart gets colour.

## The review

- **One selection drives the report, the 3D view and the slices.** Selecting
  a task, value or structure anywhere moves all of them.
- **Labels show only for the selection.** Everything else stays unlabelled.
- **Bone renders ivory by default** (`--bone`); structure label colours
  (`--label-*`) appear only with the Labels toggle.
- Slice planes keep their axis colours everywhere: coronal `--axis-x`,
  sagittal `--axis-y`, axial `--axis-z`.
- Rulers are `--ruler`; a ruler being corrected is `--ruler-edit`; a landmark
  more than 0.03 mm off the surface is `--landmark-warn`.
- Panels dock and resize by dragging; nothing floats. The 3D and slice views
  never remount when a panel resizes.

## Layout

- Each screen fills the window, and each section scrolls on its own. Below
  1100 px wide, the workflow screen falls back to one page scroll.
- Every screen handles loading, empty, error and partial states, not only
  the one in the mockup.

## Copy

- Plain labels: "Runs", "To check", "Rerun for this sample".
- Choices are worded as the user's decisions ("Accept", "Move endpoints",
  "Rerun and save to task list"), not as system states.
- Screens show state. Teach a concept once, where it first appears, then
  trust the user to know it.

[direction]: https://github.com/voluma-bio/docs/blob/main/work/microct-workflow-mvp/mockups/direction.md
