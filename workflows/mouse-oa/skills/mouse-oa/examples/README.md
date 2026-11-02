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
and the growth-plate band. The width (#10) is a chord along the growth plate on a coronal section, from the
centre of the fibula–tibia junction on the tibial surface to the point that sticks out furthest on the other side
of the plateau. The heights (#7–9) run along the shaft axis from the growth plate's face up to the top of the
articular bone: #7 from the middle of the growth plate (midway between the width points), #8 and #9 from the
middle of the medial and the lateral compartment of the plateau.

`plate_faces.py` proposes both faces of the growth plate for the iioc step, and the metaphyseal-roi step checks them again. A worker
checks the proposal against these: each proposed face lies on the plate's two edges, a few voxels apart, on every section; every
flagged stretch (red ticks in `qc-plate-<n>.jpg`, listed in `plate-faces.json`) has your own dense points from its first to its last
column, traced on a zoomed view; no straight line crosses a flagged stretch. `iioc.py` and `metaphysis_roi.py` stop on a stretch left
sparse; a To check item never replaces the retrace. The plate is a thin sheet of lower density between denser bone, and it is not
always visible: a proposal that rides a dark marrow space above it, or a sheet where no plate remains, is wrong.

**Eroded plate.** `iioc/eroded-plate-oa6-1rk-v231.jpg`: OA6-1RK, coronal section V=231, the lab's reading of the plate, traced by Jimmy.
Left of U~296 two thin lines run along the plate, some 20 to 90 µm apart; to the right the plate has been destroyed, the two lines meet
and the face follows the remaining bone. Trace what remains with both faces, densely like any flagged stretch, mark the U range where the plate is gone in `plate_eroded` (every traced section it reaches, flagged or not) with a reason (the mark
never replaces the points), and raise a To check item naming it ("V=231, U 296 to 338: plate eroded, faces traced on the remaining bone"); a search for a plate there finds another structure. OA6-1RK is eroded
(bone destruction, possibly age-related) and is not representative: OA6-2RK's plate is the typical one, and a thickness measured
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
The distal face it starts from is the one `plate_faces.py` proposed, checked and retraced where flagged or wrong (see iioc,
above); where the plate is eroded and the range marked so, the two faces meet, `metaphysis_roi.py` accepts that, ROI-3 starts below the
remaining bone, and the result record lists the marked ranges and their share: report them with the To check item.

## cortical

`cortical/deck-cortical-levels.jpg`: the two levels drawn on the opened tibia, and the cortical ring at one of them. Two slabs on the cortex mask (`slab_um` thick, centred `depth_um` below the growth plate's distal face, the two levels of `protocol.json`) following it, each covering the wall all round.

## femoral-geometry

`femoral-geometry/deck-points-a-d.jpg`: four points. `a` is the midpoint of the upper line of the intercondylar
groove and `b` the intercondylar notch, both on the front view of the femur with the shaft and the groove, DFL (4)
drawn between them; `b` again from the back. `c` is the midpoint of the ridge on the lateral condyle, shown on the
lateral side view; `d` the vertex of the medial condyle, shown with `c` on the front view, DFW (5) drawn across the
condyles. DFL is `a` to `b`, DFW is `c` to `d`.
