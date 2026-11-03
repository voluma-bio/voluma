# Run view: deferred work

- **Undo "Looks right".** The prototype offers Undo; the review API has no call to withdraw an
  acceptance.
- **Resend a stored key from Home and the study dashboard too.** Only the run page sends the
  starter's stored Meta key by itself when a run waits for keys (`AwaitingKeys` in
  `apps/web/src/features/input/input-header.tsx`). Home and the dashboard list the waiting run and link
  to it, so a guest watching a batch still opens each scan. Move the once-per-wait send into a hook
  here and use it from both features.
- Outputs review (`outputs-model.ts`): `report_output` fills `detail` from the file's sidecar
  (`affine`, `offsetZyx`, `dtype`, a surface's `axis`, a base's `unit`) but not `points`, so point and
  line overlays are listed as "not drawn yet". A sidecar without `spacing_zyx_mm` leaves the scene in
  voxel units.
