# Run view: deferred work

- **Undo "Looks right".** The prototype offers Undo; the review API has no call to withdraw an
  acceptance.
- Outputs review (`outputs-model.ts`): `report_output` fills `detail` from the file's sidecar
  (`affine`, `offsetZyx`, `dtype`, a surface's `axis`, a base's `unit`) but not `points`, so point and
  line overlays are listed as "not drawn yet". A sidecar without `spacing_zyx_mm` leaves the scene in
  voxel units.
