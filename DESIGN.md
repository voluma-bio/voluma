# Design

Visual rules the code can't show, from the [visual direction][direction].
They are review points, not CI failures. The components live in
`packages/ui`, the tokens in `packages/design-tokens`, and Storybook
(`apps/storybook`) shows each component in both themes with what it is for and
where it is used.

## Two themes, one token set

- **Light by default**, with a personal Light / Dark choice under Settings. The
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

- **One icon-only vertical navigation rail**: Studies and Workflows sit at the top of the 44 px rail,
  beneath the non-interactive Voluma mark. The sidebar spans the full height; its mark and icons
  are 20 px in 36 px slots, separated by 4 px. Breadcrumbs sit beside it, not across its top; top-level
  pages have no empty breadcrumb header.
  Separate Settings (gear) and Account actions sit at its foot. All four controls share 20 px icons
  with accessible names and hover/focus tooltips. Settings holds preferences; Account holds identity and Sign in or
  Sign out. There is no duplicate horizontal navigation. Top-level pages omit breadcrumbs;
  nested pages keep a separate, wrapping breadcrumb for study context.
  Below it each page has one h1 with metadata, status and actions; these never sit inside the
  breadcrumb. A sample uses a compact single title/metadata/status row, with Run details on the
  right; it wraps only when space runs out. Run finished means computation ended, not that the
  results were checked; show outstanding checks separately.
- **One shell on every page**: the navigation rail at the left, one workspace in the centre,
  and up to one panel on each side, only where it serves a distinct task.
  Supporting panels are optional: Study and Compare use the centre list, not a second Samples tree;
  Study details starts folded, uses only the sidebar's own control on desktop, and is an inline
  disclosure in the one-page scroll below 1100 px.
  Review's Samples tab lists every member of the current study, including Not started, and links to All studies.
  A side holds one panel, with tabs when it
  has more than one thing to show. Both sides resize by dragging, keep their width across pages,
  and fold to 28 px strips. Icon-only expand controls point in the direction the panel opens;
  their Show labels live in tooltips and accessible names. Fold controls are also icon-only,
  named by tooltips and accessible labels. Workspace panels push the centre aside; they never float.
  Transient menus, popovers (including Settings and Run details) and dialogs are the exception.
- **No divider lines in lists or between side blocks.** Spacing separates them.
- **Actions use visible controls, not character-key command shortcuts.** Preserve standard
  keyboard navigation, focused slice stepping and scoped Escape cancellation. One Escape does
  one action and restores focus; deleting a mark has a visible, session-only Undo.

## The review

- **One selection drives the Final outputs panel and all four panes.** Selecting an output
  anywhere moves all of them; the planes' orientation stays as the researcher left it.
- **Four equal panes**, or one or two. Each pane can go full screen. A chip on each pane picks
  what it shows: 3D, a slice, or the plane along the growth plate. A slice is named by its
  anatomical plane (Axial, Coronal, Sagittal) where the grid's catalog entry says which it is,
  else by the grid's axes (XY, YZ, XZ), which the chip's menu also shows. The slice number sits
  small in the pane's corner; a scale bar shows only where the run published the grid's
  geometry. The whole-run graph shows in place of the panes when the researcher asks for it.
- **The viewer's bar is icons with tooltips** (Jimmy, Nov 4): every marking tool (its tooltip
  says how to use it), Planes, Contrast and the 1, 2 and 4 pane layouts; Views, the one menu in
  words, saves the view and lists every saved one.
- **Up front is what the researcher reviews.** Statuses, values, To check, the AI's
  words, QC images and the viewer's controls show. How long something took, tries, counts, cost,
  tokens and ids sit behind an info button (`InfoButton`) or Run details, with the numbers someone
  fixing a run needs after the researcher's.
- **Labels show only for the selection.** Everything else stays unlabelled.
- **Every output shows the run's segmentation as context**: its labels on the output's grid in
  their label colours (`--label-*`), ivory (`--bone`) with "Colour each structure" off. What the output
  itself shows (its region, mask or surface) is drawn over them in `--output`: filled stronger and
  outlined on the slices, opaque in 3D with the context bones see-through. The left side's Labels
  tab says which colour is which structure, by name, with its volume where the run measured one,
  and a recoloured structure says why and shows its usual colour. There the researcher sets the
  labels' opacity, all or each, hides one, and draws the slices filled or as outlines only. The
  output's own region and the check's always draw; the viewer's bar says how many labels are hidden. An output that is the
  labels as a whole shows them opaque in their own colours. 3D shows meshes only; the raw image
  is volume-rendered only when there are none (the scan before segmentation).
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
