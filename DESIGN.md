# Design

Visual rules the code can't show, from the [visual direction][direction].
They are review points, not CI failures. The components live in
`packages/ui`, the tokens in `packages/design-tokens`, and `/dev/ui` shows
both in each theme.

## Two themes, one token set

- **Light** (the default) is for workflows and runs: Warm Organic, pine accent.
- **Dark** (`data-theme="dark"`) is for the review: an imaging workspace,
  because grayscale slices read best on near-black.
- Components use semantic token utilities (`bg-surface`, `text-fg-muted`,
  `border-line`), never raw colours. A colour a screen needs goes into
  `tokens.css` with a role name and a value for both themes.
- Type is IBM Plex Sans, with IBM Plex Mono for values, units and ids.
  Numbers in columns use tabular figures.

## Status

- **Status lives in the list, never in mesh colour.** Task, run and
  structure status shows as a badge or dot in lists and reports.
- The one exception: the region under check is outlined in amber
  (`--check-outline`) on the slices and in 3D.
- Amber always means To check; blue means running or corrected; pine means
  done. Don't reuse them for decoration.

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
