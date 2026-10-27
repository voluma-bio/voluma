# Application scaffold and review

## Ownership

- `apps/app` composes routing, QueryClient, and the selected service. It has no
  analysis or correction logic. The runs route is only a demo navigation stub.
- `packages/review` owns report presentation, correction interactions, local
  viewer settings, and the simulated service behind `ReviewService`.
- `packages/run` reserves the other lane's public entry point. No harness is built.
- `packages/contracts` owns JSON-natural shared schemas and inferred types.
  These are provisional Review contracts, not an agreed harness event protocol.
- `packages/design-tokens` owns the light Warm Organic palette and typography.
  Both workspace chrome and viewer placeholders are light. This follows Andrew's
  instruction in the implementation thread; the older dark mockup is not the theme spec.

## Results and revision safety

Router search parameters own the task and run snapshot selection. Query owns
service snapshots; React owns panel sizes, drafts, visibility, and opacity.
No network calls occur in UI components: all data operations use `ReviewService`.

A revision is currently a whole-run snapshot. Each task's `resultRevisionId`
identifies the revision that generated its result, so unrelated tasks keep their
identity when downstream work reruns. Earlier snapshots become read-only.
Accepting a check records a review decision; it does not validate a measurement.

The demo computes transitive impact from task dependencies, deduplicates
confirmation, rejects stale proposals, and preserves results on failure. Only a
successful confirmation appends a revision. The real service must provide these
same guarantees server-side; the frontend is not an authorization boundary.

## Data provenance and simulation

Fixture content is adapted from the [approved mockup][mockup] and [requirements].
The private OA6-1RK manifest, meshes, QC images, and files are not available here.
Femoral baseline values approximate documented comparisons and are explicitly
synthetic. Trabecular baseline thickness/separation and ossification volume are
transcribed numbers. All other unavailable measurements remain null.
Structure declarations, IDs, timestamps, and workflow version are demo metadata.

The simulator's revised numbers are scripted display fixtures, never measurements
recomputed from an instruction. New evidence is unavailable rather than inherited
as if it supported a new result. Session state resets on browser reload.
`DemoControls` is separate from the integration interface and exercises load/rerun
failures. It is not a production API.

## Integration and verification

Replace the service at the app composition root when the Run lane's API is ready.
Validate its JSON against shared schemas there; agree checkpoint identity,
authentication, durable review decisions, asset access, and run-event transport
before connecting real data. No backend hosting or database choice is made here.

View slots remain mounted across task changes and maximize/restore; renderers can
later attach inside them. At narrow widths, the report and viewers stack in a
single page; desktop panels scroll independently and resize with pointer/keyboard.

`pnpm check` runs the repository gate. Service tests cover dependency impact,
unchanged earlier results, acceptance/confidence separation, failed rerun/retry,
duplicate confirmation, stale proposals, question scope, and CSV provenance.
Browser verification is also required for UI changes; unit tests do not prove
layout, resize, focus handling, or download behavior.

The PR-body check enforces the local template. The referenced meridian-flow source
was not available in the attached checkouts, so this is a small local implementation,
not an as-is port. It reads PR text as data with read-only CI permissions.

[mockup]: https://github.com/voluma-bio/docs/blob/main/work/microct-workflow-mvp/mockups/review-live.html
[requirements]: https://github.com/voluma-bio/docs/blob/main/work/microct-workflow-mvp/requirements.md
