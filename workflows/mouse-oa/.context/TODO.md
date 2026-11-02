# mouse-oa TODO

- **Each region mask is saved twice.** `iioc.py`, `tibial_trabecular.py` and `metaphysis_roi.py` write the full-grid array later
  scripts read (`iioc-tissue.npy`, `iioc-trab-tissue.npy`, `roi3-tissue.npy`, `cortex.npy`) and a cropped copy that is the mask object
  (`roi-iioc.npy`, `roi-iioc-trabecular.npy`, `roi-metaphyseal.npy`, `cortex-object.npy`). The voxels are identical. Direction: the
  consumers (`tibial_trabecular.py`, `metaphysis_roi.py`, `morphometry.py`) read the cropped object through `objects.load` and
  `objects.dense`, then the full arrays and the invented `cortex-object` name go.
- **`plate_faces.py` follow-ups.** (1) The flags were tuned on 7 hand-traced sections of three scans; the dip flag fires on almost no column
  (it was set on OA6-1RK V=231 right side only; a positive threshold flagged 45 to 70% of the columns) and the face-distance flag is new: re-tune when more hand traces exist. About 15 to 38% of
  the unflagged face columns of OA7-1L V=136/224 and OA6-1RK V=102 are still over 105 µm from his lines; the flags do not see a
  convincing sheet on the wrong structure, so the worker's look is the check. (2) The proposal is not yet scored on a traced section by a worker; judge the instructions on a run with the production
  model, not on a stand-in (`workflows/core/AGENTS.md`). (3) `iioc.py` cannot run on OA6-1RK's stored frame (old format): rerun `tibia_frame.py` for that scan. (4) The coverage rule (`min_run_um` 210, `bridge_um` 1000, `max_surface_slope` 1.5, `off_tibia_margin_um` 105) comes from the first run's failures (OA6-2RK, local run 991c50b3), not from fitting hand lines (Jimmy: his traces are rough in height too). Judge it on the next production-model run: how far past the spans the worker has to trace, and whether it traces or fills. Where the search is wrong inside a span (OA7-1L V=185 U 214 to 234, V=220/224 U about 235 to 242: a different structure just above the plate), the render is still the only check.
