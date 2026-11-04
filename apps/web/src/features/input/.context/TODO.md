# Input review: deferred work

## Recorded-run acceptance

- [#142](https://github.com/voluma-bio/voluma/issues/142): Jimmy still needs to explain a recorded
  run's task purpose, work, evidence and remaining decisions unaided, without a jargon table.
  The browser walk of ce5a0f21 establishes reachability, not researcher comprehension.
- [#145](https://github.com/voluma-bio/voluma/issues/145): verify genuine recorded post-#306
  provider fail-fast and waiting (lost-lease) states when records are available.
  The retained 2026-10-30 archive covers historical error rendering and attribution only.
  Do not synthesize those records or restore spend caps/outage holds. Acceptance status stays
  with #210/#174. Bounded rendering fixes: [#327](https://github.com/voluma-bio/voluma/pull/327).

## Outputs review

- **A published ruler's end dragged** is not yet seen on real data: no run draws rulers yet. The drag shares the mark-end path that was walked; the ruler's candidates come from the
  scene's 2-point annotations.
- Ends drag only in slices, not in 3D; boxes, outlines and probes have no handles.
- Rests on rows have no swatch or eye: the panes can't yet show or hide one overlay from the list
  (mockup C's legend). The slices' Lat/Med letters are Andrew's call.
- Presets per output ("XZ at V 125"), the value pinned on its overlay, and the pane's slice
  counter in the grid's own letters (U, V, W) wait for the workflow to define views.
- A collection output opens as a table: not built ("Lists open here as a table in a later version").

## Outputs review, from the am-marks review (p1306, p1307)

- Two people marking one run at once can both get P3: `nextTag` (`marking.tsx`) counts the
  marks this tab has seen. Cosmetic.
- Probe and Point share the letter P in `TOOLS`; tags stay unique (one counter), but a tag
  can't tell the kind.
- `useSavedViews` (`saved-views.ts`) never clears `pendingFor`: after one save, any later
  `view.saved` for that output, another person's included, becomes the one shown.
- Per-event costs: `marksOf`, `toldMarks`, `agentLog` and `conversation` each rescan the whole
  log per durable event.

## Outputs review while a run goes (#466)

- No screenshot yet of values in while the run still goes: run 0b502d18 closed seconds after its
  one value. Take it on the next live run.
- **The page swaps runs when a newer run appears.** Without `?run=` the page shows the input's
  newest run from the study query, which polls while a run is live. When a "run again" action
  exists, a new run remounts the page and drops the selection and unsent marks: resolve the newest
  run once on mount and offer "A newer run started" instead.

## Review readable (jimyao/review-readable)

- The Labels tab is called "Labels", not "Segmentation": three tabs with "Segmentation" don't fit the
  left side's 300 px default. Tab icons hide between 260 and 340 px so three labels fit.
- At about 1100 px wide the centre is ~360 px: the viewer's bar wraps to three rows and the scene
  bar's output name truncates to nothing. Either shrink Planes and Contrast to icons there or let
  the centre fall back to the page scroll earlier.
- "Agents" in the scene bar and the Agents view still use worker names: a debugging view, left as is.
- The item card's "Show" and the scene bar are the "Show" framing work's (another PR).
- Labels sliders apply on release: each display change rebuilds the scene's overlays, and every
  slice pane rereads its planes (from the worker's chunk cache) before composing. Keeping an
  overlay's data apart from its look (colour, opacity, style), so a look change only recomposes,
  would let the sliders apply live.
