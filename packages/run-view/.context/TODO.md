# Run view: deferred work

- **Undo "Looks right".** The prototype offers Undo; the review API has no call to withdraw an
  acceptance.
- Outputs review (`outputs-model.ts`): `report_output` fills `detail` from the file's sidecar
  (`affine`, `offsetZyx`, `dtype`, a surface's `axis`, a base's `unit`) but not `points`, so point and
  line overlays are listed as "not drawn yet". A sidecar without `spacing_zyx_mm` leaves the scene in
  voxel units.
- Agent traces (`transcript.ts`): the divider where a `main.N` review thread starts has been seen
  only in the story; check it on the first review-loop run (#530) and fix what reads wrong.
- Agent traces: reasoning inside an opened fold shows in full, not folded thought by thought. If
  long folds get hard to scan, give each reasoning step its own closed row.

## Conversation thread (from the #597 review)
- After a Yes, the approval card says "Done" but not which version was published. The held step has no row, and the approved job adds no `tool.call`. Show the `output.published` version or the `approval.settled` text on the card.
- A held call's row shows "running" for the few seconds before `approval.requested` lands, then disappears. Defer the visible row for gated tools while the run is reviewing.
- `held` in `threadRows` is keyed by `toolCallId` alone. Key it by `${threadId}:${toolCallId}`.
- Fold labels and the live line rely on main's `activity` lines, but main on deepseek-flash wrote none on run 908b9361 (#596).
