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
  model, not on a stand-in (`workflows/core/AGENTS.md`). (3) An eroded mark is the whole flagged stretch, which the search can merge with plate on both sides (OA6-1RK V=229 U=190..316), so the reported eroded share is an upper bound: let the worker split a stretch if that matters. (4) `iioc.py` cannot run on OA6-1RK's stored frame (old format): rerun `tibia_frame.py` for that scan.
