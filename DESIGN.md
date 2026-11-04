# Design

Visual rules the code can't show, from the [visual direction][direction].
They are review points, not CI failures. The components live in
`packages/ui`, the tokens in `packages/design-tokens`, and Storybook
(`apps/storybook`) shows each component in both themes with what it is for and
where it is used.

## Two themes, one token set

- **Light by default**, with a personal Light / Dark choice under Settings on the rail. The
  choice applies to every page, including navigation, reports, controls and pane headings. The
  3D and slice image wells stay dark in both themes for anatomy contrast.
- Components use semantic token utilities (`bg-card`, `text-muted-foreground`,
  `border-border`), never raw colours. The names are shadcn/ui's, with our palette as the values;
  `accent` is shadcn's hover fill and `primary` the ink-filled main action. A colour a screen needs goes into
  `tokens.css` with a role name and a value for both themes.
- Type is Instrument Sans, with IBM Plex Mono for values, units and ids. Body is 14px.
  Numbers in columns use tabular figures.

## Status

- **Status lives in the list, never in mesh colour.** An output's status (pending, reported,
  to check, missing, out of date) and a run's show as a `StatusMark` (glyph and word) in lists
  and reports.
- The one exception: the region under check is outlined in amber
  (`--check-outline`) on the slices and in 3D.
- Amber always means To check; violet means running or checking; green means
  done; red stopped; grey waiting. Ice (`select`) means selection only. Don't reuse them for
  decoration.

## Comparing samples

- **Comparisons live on a study's Compare page**, not on the study page, which stays calm: which
  sample needs you.
- **Groups of samples compare as strip plots, not bars** (`StripPlot`): every sample a dot, a tick for the
  group mean. Groups hold 1 to 8 samples, and a bar or box hides them.
- Dots are ink; only a sample far from its group turns amber, with its name beside it. Nothing else
  in a chart gets colour.

## The shell

- **One shell on every page**: a 44 px rail at the far left (Studies, Workflows, Settings), one
  panel on each side, the page's work in the centre. A side holds one panel, with tabs when it
  has more than one thing to show. Both sides resize by dragging, keep their width across pages,
  and fold to 28 px icon strips. Panels push the centre aside; nothing floats.
- **No divider lines in lists or between side blocks.** Spacing separates them.

## The review

- **One selection drives the Final outputs panel and all four panes.** Selecting an output
  anywhere moves all of them; the planes' orientation stays as the researcher left it.
- **Four equal panes**, or one or two. Each pane can go full screen. A chip on each pane picks
  what it shows: 3D, a slice named by the grid's axes (XY, YZ, XZ), or GP, the plane along the
  growth plate. The whole-run graph shows in place of the panes when the researcher asks for it.
- **Up front is what the researcher reviews.** Statuses, values, To check, the AI's
  words, QC images and the viewer's controls show. How long something took, tries, counts, cost,
  tokens and ids sit behind an info button (`InfoButton`) or Run details, with the numbers someone
  fixing a run needs after the researcher's.
- **Labels show only for the selection.** Everything else stays unlabelled.
- **Bone renders ivory by default** (`--bone`); structure label colours
  (`--label-*`) appear only with the Labels toggle.
- **Plane colours follow the anatomy on every grid**: coronal red, sagittal green, axial blue
  (`--plane-coronal`, `--plane-sagittal`, `--plane-axial`),
  whether the scan sits on its own grid or the tibia's. A tilted plane (GP) takes the colour of
  the anatomical plane its normal is nearest. The solids are made for the dark image wells and
  fail 4.5:1 on light surfaces, so text in the chrome (an axis letter, a mark's tag) takes the
  matching `--plane-*-text` ink.
- Rulers are `--ruler`; a ruler being corrected is `--ruler-edit`; a landmark
  more than 0.03 mm off the surface is `--landmark-warn`.
- The 3D and slice views never remount when a panel resizes or folds.

## Layout

- Each screen fills the window, and each section scrolls on its own. Below
  1100 px wide, the workflow screen falls back to one page scroll.
- Every screen handles loading, empty, error and partial states, not only
  the one in the mockup.

## Copy

- Plain labels: "To check", "Samples".
- One scanned knee is a **Sample** on screen, written only through `INPUT_WORD` (`@voluma/ui`), the
  mouse-OA workflow's noun; a **run** is one go of the AI over it. Code, routes and the API call it
  an `input`.
- Choices are worded as the user's decisions ("Accept", "Move endpoints",
  "Save a view"), not as system states.
- Screens show state. Teach a concept once, where it first appears, then
  trust the user to know it.

[direction]: https://github.com/voluma-bio/docs/blob/main/work/microct-workflow-mvp/mockups/direction.md
