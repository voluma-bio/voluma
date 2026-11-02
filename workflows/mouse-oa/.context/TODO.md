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
  model, not on a stand-in (`workflows/core/AGENTS.md`). (3) `iioc.py` cannot run on OA6-1RK's stored frame (old format): rerun `tibia_frame.py` for that scan. (4) The proposal comes from the search along U alone (the V-direction search was right on about half the hand-traced columns, the U search on two thirds to three quarters, and averaging them lost the arch); its coverage rule (`min_run_um` 315, `bridge_um` 1000, `max_surface_slope` 1.5, `off_tibia_margin_um` 105) comes from the first run's failures (OA6-2RK, local run 991c50b3), not from fitting hand lines (Jimmy: his traces are rough in height too). Judge it on the next production-model run: how far past the spans the worker has to trace, and whether it traces or fills. The search still cannot see the plate on the arch's outer sides (OA6-2RK V=220/225, U below ~100 and above ~285: it is a thin line inside bright bone and just outside the tibia mask, so the valley cost is empty there and the search goes flat; widening the band beyond the mask made OA6-1RK worse), and it proposes short fragments on the epiphyseal roof of some back sections (V=275, 305, 329); where the search is wrong inside a span (OA7-1L V=185 U 214 to 234: a different structure just above the plate), the render is still the only check.
- **The width check (#10) is set on two runs.** `iioc.py` refuses a width point more than `width_point_off_face_um` from the proximal
  face's curve on its coronal section, or more than `off_tibia_margin_um` off the tibia mask there (past the curves' ends the face is
  held flat across the grid, so a point beside the tibia would sit on it); 200 µm sits between OA6-2RK run 991c50b3's right points
  (141 and 51 µm) and run f45f630f's wrong ones at the top of the epiphysis (669 and 575 µm). Re-judge it on the next runs. The check
  does not judge where along the face the ends are: two points anywhere on the face over the tibia, on one section, pass, so whether
  they are the fibula–tibia junction and the prominent point opposite is still judged by eye.
