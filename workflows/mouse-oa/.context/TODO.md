# mouse-oa TODO

- **A labels fix after the tracing voids the tracing.** `iioc.py` stops where ROI-1's side runs through bone the tibia label
  left out; fixing the labels and rerunning `tibia_frame.py` makes a new `grid_id` (the frame's origin and crop come from the
  mask), and every traced curve, eroded mark and width point is refused on it. Next: `tibia_frame.py --frame <tibia-frame.json>`
  to resample a corrected mask onto the existing frame, or run the side test before tracing (at `tibia_frame.py`).
- **A face's straight line between two pieces reads as a traced face.** Where a coronal section cuts the plateau in two (the
  notch, the posterior condyles), a curve has points on both pieces and the schema joins them with a line across empty space
  (4df02afe V=271: 788 um more than `off_tibia_margin_um` off the mask; the hand traces in `~/experiments/plate-data/scans` do the
  same on 30 of 45 scans, up to 1134 um, and OA6-2RK's NOTES call it "not a traced point"). So no check refuses it: ROI-1 and ROI-3
  are clipped to the mask, and the line adds no volume. `face_qc.delivered_faces` draws it solid, which a reviewer reads as a face
  through air: draw it dotted where it is more than the margin off the tibia.
- **`femoral_frame.py`'s femur-length gate sits at the edge of real scans.** `MIN_FEMUR_MM` 4.5 was set from two scans; femur
  length along the shaft on threshold-split labels of five lab scans: OA6-2RK 5.86, OA6-1RK 5.31, OA7-1L 5.19, OA7-4R 5.14,
  OA8-17L 4.57 mm. A scan framed a little lower stops the femoral step with a To check. Next: fit the shaft on narrow
  diaphysis slices so a shorter stub still gives the right axis, then lower the gate; check on the OA8 series.
- **`tibia_frame.py` on flexed or bowed tibiae (unconfirmed).** Preparing 17 lab scans for the growth-plate dataset, 4 gave
  oblique aligned grids (OA7-5L, OA7-6L, OA7-8L, OA8-1R: shaft leaving the grid, plateau sloping steeply across coronal
  sections, no clean plate level). Their tibia labels came from a quick threshold-and-erosion split
  (`~/experiments/plate-data/scans/TIBIA-MASK.md`), not from segmentation, and OA7-8L's took femur pieces, so the cause may be
  the label rather than the shaft-axis fit. The fit now follows the shaft over `--axis-mm` from the joint end, which may already fix them. Next: rerun
  `tibia_frame.py` on one of them with a checked tibia label and check both QC sheets. Notes per scan: `~/experiments/plate-data/scans/_skipped/<scan>/SKIPPED.md`.
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
- **ROI-3's cortex edge is one depth all round.** `metaphysis_roi.py` keeps ROI-3 `cortex_estimate_mm` plus `cortex_clearance_um`
  from the outer edge on every axial slice, the estimate being the wall just below the plate (OA6-2RK 0.147 mm), so where the wall
  is locally thicker ROI-3 reaches into it. On OA6-2RK (the local Opus run's distal curves): the tibial tuberosity, V below 100 and
  W 138 to 154, where 60% of ROI-3's bone is in structures at least 126 µm thick; and the ring 0.17 to 0.38 mm inside the edge,
  which ROI-3 gained when the estimate fell from 0.357 mm: 62% bone, mean thickness 89 µm, against 29% and 64 µm deeper in (ROI-3
  BV/TV 29.2 to 42.2%, Tb.Th 58 to 79 µm). Whether the lab's ROI-3 keeps that ring is open: ask for their ROI-3 on one scan. If it
  does not, the direction is an inner (endocortical) edge found per slice, the thick bone joined to the outer edge, with the clearance
  measured from it. Those curves also cross the solid tuberosity at V=50 and 71, where V=70 shows no plate band: ROI-3 there lies
  inside that bone whatever the edge.
- **The width check (#10) is set on two runs.** `iioc.py` refuses a width point more than `width_point_off_face_um` from the proximal
  face's curve on its coronal section, or more than `off_tibia_margin_um` off the tibia mask there (past the curves' ends the face is
  held flat across the grid, so a point beside the tibia would sit on it); 200 µm sits between OA6-2RK run 991c50b3's right points
  (141 and 51 µm) and run f45f630f's wrong ones at the top of the epiphysis (669 and 575 µm). Re-judge it on the next runs. The check
  does not judge where along the face the ends are: two points anywhere on the face over the tibia, on one section, pass, so whether
  they are the fibula–tibia junction and the prominent point opposite is still judged by eye.
- **Workers name scan axes from crops whose axes they do not label.** On OA6-2RK run 0ed8e7d3 the femoral worker plotted
  axial crops with pixel offsets on both axes and read the condyles as side by side along y (they sit along x), as the
  f45f630f worker had. `femoral_frame.py` now confirms its axis against the bending plane, so the femoral step catches it,
  but any landmark step that reads directions off a worker-made crop can repeat it. Next: one knee-axes helper (from
  `frame.json`'s bending-plane normal and shaft axes) that prints which scan axis runs side to side, front to back and
  along the shafts, for workers and scripts to read instead of their own crops.
- **A distal face copied from the proximal one is not refused.** Refuse a constant-offset distal face only where it misses the
  plate's lower edge in HU; a geometric test can't tell it from honest thin-plate traces typed as (U, proximal, distal) triples.
  Needs 0ed8e7d3's aligned HU rebuilt to calibrate. On 6 of the 9 by-eye traces in `~/experiments/plate-data/scans/<scan>/trace/`,
  5 to 13 sections keep the distal face within a 0.5-voxel band of one offset from the proximal over 100 or more columns
  (OA6-2RK's plate-test-opus trace: 12 of 19); run 0ed8e7d3's copied faces: 15 of 28. The same HU check would catch one misread
  section between sparse neighbours, which `refuse_jumps` passes when it is less than about 330 to 420 µm off with neighbours 16 to 20 apart. It would also catch a worker that clears a jump refusal by deleting the sections in between: the sections left still
  pass the jump and gap checks with the same generated points (0ed8e7d3 with V=202 and 212 removed passes from V=197 to 217).
- **`tibia_frame.py --joint-end` automatic.** The script already finds the joint end from where the femur lies and refuses a flag that disagrees; drop the flag and take that end.
- **`tibia_frame.py`'s femur/tibia check and bridged fragments.** A fragment joined to a bone by a thin bridge counts as part of its largest piece, and can make a correct tibia read as swapped, or hide a swap (review of the tibia-pick PR, synthetic bridges on OA6-2RK). Open each bone by 2-3 voxels before taking its largest piece, on a 2x subsample, which also takes back the check's extra 1 GB of peak memory.
- **Test where a growth-plate face ends.** `refuse_gaps` tests only gaps over the plate: the tibia mask does not show where the plate ends (the condyles overhang it, the fibula lies beside it), and an outline-based end test passed faces 1 mm short while refusing correct ones (#558's review). Build the plate's extent from the plate itself (an HU band, or `segment_plate`'s voted band) and refuse a face that stops short of it; the same extent would close the 6% of sections where a 500 um mid-section gap still passes the mask-based rule.
- **`refuse_off_tibia` on lab hand traces.** It stops 12 of the 45 hand traces in `~/experiments/plate-data/scans/*/trace/` (37 with their `ends.json` merged): check whether its margin or those traces are wrong.

- **IIOC height columns vs "the centre of the growth plate's cross-sections" (expert, Nov 4).** On the long axis he said
  "the measurement of the maximal height of the IIOC and the height of medial and lateral compartment of IIOC may be based
  on the center of cross-sections of the growth plate". `iioc.py` today places #7 at the U midway between the width points
  (or `growth_plate_mid_u`) on the section of largest local height (or `height_section_v`), and #8/#9 at the worker's
  `compartment_midpoint_u` on that section; none is derived from the growth plate's cross-section centres. Ask the lab
  which centre (per coronal section? the plate's centroid?) and whether the medial/lateral columns are centres of each
  compartment's plate cross-section; then derive the columns from the plate rather than from worker points.
