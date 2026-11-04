# Run view: deferred work

- **Undo "Looks right".** The prototype offers Undo; the review API has no call to withdraw an
  acceptance.
- **Resend a stored key from the study page too.** Only the input page sends the starter's stored
  Meta key by itself when a run waits for keys (`AwaitingKeys` in
  `apps/web/src/features/input/input-header.tsx`). The study page lists the waiting run and links to
  it, so a guest watching a batch still opens each sample. Move the once-per-wait send into a hook
  here and use it from both features.
- Outputs review (`outputs-model.ts`): `report_output` fills `detail` from the file's sidecar
  (`affine`, `offsetZyx`, `dtype`, a surface's `axis`, a base's `unit`) but not `points`, so point and
  line overlays are listed as "not drawn yet". A sidecar without `spacing_zyx_mm` leaves the scene in
  voxel units.
- Agent traces (`transcript.ts`): the divider where a `main.N` review thread starts has been seen
  only in the story; check it on the first review-loop run (#530) and fix what reads wrong.
- Agent traces: reasoning inside an opened fold shows in full, not folded thought by thought. If
  long folds get hard to scan, give each reasoning step its own closed row.
