# mouse-oa TODO

- **Each region mask is saved twice.** `iioc.py`, `tibial_trabecular.py` and `metaphysis_roi.py` write the full-grid array later
  scripts read (`iioc-tissue.npy`, `iioc-trab-tissue.npy`, `roi3-tissue.npy`, `cortex.npy`) and a cropped copy that is the mask object
  (`roi-iioc.npy`, `roi-iioc-trabecular.npy`, `roi-metaphyseal.npy`, `cortex-object.npy`). The voxels are identical. Direction: the
  consumers (`tibial_trabecular.py`, `metaphysis_roi.py`, `morphometry.py`) read the cropped object through `objects.load` and
  `objects.dense`, then the full arrays and the invented `cortex-object` name go.
- **`plate_faces.py` follow-ups.** (1) A check that a worker's `annotations.json` has points on every flagged stretch of `plate-faces.json`
  (today the instructions say so; nothing refuses a flagged stretch left bridged). (2) The flags were tuned on 7 hand-traced sections
  of three scans, the dip flag on OA6-1RK V=231 right side only (it fires on almost no column elsewhere): re-tune when more
  hand traces exist. (3) The proposal is not yet scored on a traced section by a worker; judge the instructions on a run with the
  production model, not on a stand-in (`workflows/core/AGENTS.md`).
