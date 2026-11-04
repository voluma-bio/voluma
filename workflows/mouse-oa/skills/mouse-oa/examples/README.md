# What correct looks like, per step

For each placement a step makes: the criterion, and the lab's figure of it done right. A worker places against
these; whoever looks at the result writes down what it expects from them before opening the worker's images. Every figure is a
crop from the lab's parameter deck unless its name says otherwise.

## intake

The keyframe of the rough orientation cuts the femur and the tibia in one slice through the joint, with the joint
space between them dark and open, and the patella too when the scan's notes put it in the field. The view says which
bone is on top. No deck figure of the keyframe: the frame is ours, not the lab's.

## segmentation

`segmentation/deck-patella-menisci.jpg`: the lab's parameters #1 (patella), #2 (lateral meniscus with osteophytes) and #3 (medial) on the knee, front and back. Each label is one bone: on the 3D sheet no colour reaches onto a neighbour, every structure that is present and
named carries its colour, and a piece nobody can name stays uncoloured with a To check item asking what it is. On
the quad view every joint face's boundary runs through the dark joint space, never through bone. The patella is the large
bone in front of the femur in the trochlear groove; a small piece near the joint is a sesamoid or a fragment,
whatever its box was called. Labels 5 to 12 (`../references/anatomy.md`) are small blobs a few tens of voxels across, each its
own label.

## iioc

`iioc/deck-roi1-heights-width.jpg`: the tibia opened along the shaft, the growth plate, and ROI-1 above it with the heights 7, 8, 9 and the width 10 drawn on. ROI-1 runs from the growth plate's proximal face up to the articular surface of the tibial plateau, over the whole
plateau: on a coronal section the region sits on the traced face, includes the marrow, and excludes the femur
and the growth-plate band. The width (#10) is a chord on one coronal section with both ends on the growth plate's
proximal face, from the centre of the fibula–tibia junction on the tibial surface to the point that sticks out
furthest on the other side of the plateau. The heights (#7–9) run along the shaft axis from the growth plate's face up to the top of the
articular bone: #7 from the middle of the growth plate (midway between the width points), #8 and #9 from the
middle of the medial and the lateral compartment of the plateau.

The proposal (`segment_plate`) gives both faces of the growth plate for the iioc step, where it finds the plate (a part of the tibia: its V
range and each section's U span are in `plate-faces.json`), and the metaphyseal-roi step checks them again. The proposal is where the worker
starts: the faces must follow the plate over the whole tibia at plate level, past each span end and on the sections with no span, out to the V
ends. A worker checks its faces against these: each lies on the plate's two edges, a few voxels apart, on every section; every flagged
stretch (red ticks in `qc-plate-<n>.jpg`, listed in `plate-faces.json`) has been looked at on a zoomed view and retraced where wrong, with points the worker read off the view
wherever it opens a gap wider than `max_gap_um`; every suspect band piece (named in the sheet's title) has been opened, and faces on a stray (the fibula, another bone) taken out with `prune_plate.py`. The positions are read by looking: code may write them down, but a detector or interpolator choosing them is not tracing, and
`iioc.py` and `metaphysis_roi.py` passing (they stop on points or sections more than `max_gap_um` apart over the plate and on points off the tibia; they do not test where a face ends; `iioc.py` also stops where ROI-1's side runs through bone, where the tibia label stops short of the cortex) does not mean the face is on the plate or reaches its ends.
The plate is a thin sheet of lower density between denser bone, and it is not
always visible: a proposal that rides a dark marrow space above it, or a sheet where no plate remains, is wrong. The right face follows the
same visible plate band end to end, including where it wraps down the condyles at the sides of the arch; it is wrong
where it switches onto the cortex or the marrow. Where a single-valued face cannot represent the anatomy (in the notch, which can run nearly in
the section's plane) the worker has read the neighbouring sections and raised it in a To check item, not flattened it or called it eroded.
The check opens every `qc-faces-<n>.jpg` of the step, sheet by sheet: `iioc.py` writes them, one panel per traced section, the proximal face as the
worker delivered it (solid between traced points, dotted where held constant past them) over the tibia's outline, the crop reaching 0.8 mm beyond the faces' height range (a band farther from the faces than that is not in the
sheet: look at the zoomed views for it). On each: the line lies on the plate band, including down a condylar wrap, stays on the bone from end to end, and does not
leave the plate for cortex or marrow; a dotted stretch over the plate longer than `max_gap_um` is untraced plate, which is a failure; a sheet not opened is a check not done.

**Eroded plate.** `iioc/eroded-plate-oa6-1rk-v231.jpg`: OA6-1RK, coronal section V=231, the lab's reading of the plate, traced by Jimmy.
Left of U~296 two thin lines run along the plate, some 20 to 90 µm apart; to the right the plate has been destroyed, the two lines meet
and the face follows the remaining bone. Trace what remains with both faces, densely, mark the U range where the plate is gone in `plate_eroded` (every traced section it reaches, flagged or not) with a reason (the mark
never replaces the points), and raise a To check item naming it ("V=231, U 296 to 338: plate eroded, faces traced on the remaining bone"); a search for a plate there finds another structure. OA6-1RK is eroded
(bone destruction, possibly age-related) and is not representative: most of the lab's knees keep the plate whole, and a thickness measured
on OA6-1RK is not a thickness of the plate.

## subchondral-plate

`subchondral-plate/deck-plate-patches.jpg` (Tang et al.): a coronal section with the medial and lateral patches (`plate_patch_width_um` wide). Green is the subchondral bone plate, what #11 and #12 measure; red is the trabecular bone under it, which this step does not measure. The plate patch is a column around the middle of each plateau compartment (medial, lateral), and the
measured slab lies under the articular top surface, inside the plate (the green), not down in the trabeculae (the red).

## trabecular-roi

`trabecular-roi/deck-roi2.jpg`: ROI-2 lifted out of ROI-1 as the trabecular core. ROI-2 is ROI-1 without the subchondral plate above and the cortical line next to the growth plate below: on a
coronal section it sits under the plate and inside the cortex, with marrow and trabeculae only.

## metaphyseal-roi

`metaphyseal-roi/deck-roi3.jpg`: ROI-3 outlined on the opened tibia, with the offset, the length and the clearance drawn (the spec's `start_um`, `length_um`, `cortex_clearance_um`), and the trabeculae it holds. ROI-3 starts that offset below the growth plate's distal face, runs that length toward the shaft, and stays that clearance clear of the
cortex all round: on a coronal section it is a band in the marrow under the plate, nowhere touching the cortical
wall; on an axial slice it is the marrow space with a clear margin to the cortex. The cortex mask is the wall
only, and never reaches the fibula.
The distal face it starts from is the one the proposal gave, checked and retraced where flagged or wrong (see iioc,
above); where the plate is eroded and the range marked so, the two faces meet, `metaphysis_roi.py` accepts that, ROI-3 starts below the
remaining bone, and the result record lists the marked ranges and their share: report them with the To check item.
The check opens every `qc-faces-<n>.jpg` of the step too: `metaphysis_roi.py` draws the distal face (magenta) and the proximal one (orange)
as delivered on every traced section over the tibia's outline, and the distal line must lie on the plate's lower edge, on the bone, following the same band through any condylar wrap and not leaving it for cortex or marrow.

## cortical

`cortical/deck-cortical-levels.jpg`: the two levels drawn on the opened tibia, and the cortical ring at one of them. Two slabs on the cortex mask (`slab_um` thick, centred `depth_um` below the growth plate's distal face, the two levels of `protocol.json`) following it, each covering the wall all round.

## femoral-geometry

`femoral-geometry/deck-points-a-d.jpg`: four points. `a` is the midpoint of the upper line of the intercondylar
groove and `b` the intercondylar notch, both on the front view of the femur with the shaft and the groove, DFL (4)
drawn between them; `b` again from the back. `c` is the midpoint of the ridge on the lateral condyle, shown on the
lateral side view; `d` the vertex of the medial condyle, shown with `c` on the front view, DFW (5) drawn across the
condyles. DFL is `a` to `b`, DFW is `c` to `d`.
