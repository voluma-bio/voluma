# What correct looks like, per task

For each placement a task makes: the criterion, and the lab's figure of it done right. A worker places against
these; a checker writes down what it expects from them before it opens the worker's images. Every figure is a
crop from the lab's parameter deck unless its name says otherwise.

## orientation

The keyframe cuts the femur, the tibia and the patella in one slice, with the joint space between femur and tibia
dark and open. No deck figure: the frame is ours, not the lab's.

## segmentation

Each label is one bone: on the 3D sheet no colour reaches onto a neighbour and no bone is uncoloured. On the quad
view every joint face's boundary runs through the dark joint space, never through bone. The patella is the large
bone in front of the femur in the trochlear groove; a small piece near the joint is a sesamoid or a fragment,
whatever its box was called. Labels 5 to 12 (`anatomy.md`) are small blobs a few tens of voxels across, each its
own label.

## iioc

ROI-1 runs from the growth plate's proximal face up to the articular surface of the tibial plateau, over the whole
plateau: on a coronal section the region sits on the traced face, includes the marrow, and excludes the femur above
and the growth-plate band below. The width (#10) joins the centre of the fibula–tibia junction on the tibial surface
to the most prominent point on the other side of the plateau. The heights (#7–9) run from the growth plate to the
top of the articular bone, whole, medial and lateral.

## subchondral-plate

The plate patch is a 500 µm wide column around each compartment's midpoint, and the measured slab lies under the
articular top surface, inside the plate, not down in the trabeculae: the deck figure shows where the column sits
on the plateau.

## trabecular-roi

ROI-2 is ROI-1 without the subchondral plate above and the cortical line next to the growth plate below: on a
coronal section it sits under the plate and inside the cortex, with marrow and trabeculae only.

## metaphyseal-roi

ROI-3 starts 50 µm below the growth plate's distal face, runs 200 µm toward the shaft, and stays 20 µm clear of the
cortex all round: on a coronal section it is a band in the marrow under the plate, nowhere touching the cortical
wall; on an axial slice it is the marrow space with a clear margin to the cortex. The cortex mask is the wall
only, and never reaches the fibula.

## cortical

Two slabs on the cortex mask, 100 µm and 1000 µm below the growth plate's distal face, each covering the wall all
round.

## femoral-geometry

Four points (deck slide 7): `a` the midpoint of the upper line of the intercondylar groove, `b` the intercondylar
notch, `c` the midpoint of the ridge on the lateral condyle, `d` the vertex of the medial condyle. `a` and `b` are
placed on a long side-on view of the femur that shows the shaft and the groove; `c` and `d` on the joint-face view.
DFL is `a` to `b`, DFW is `c` to `d`; DFL under 0.4 of DFW means `a` and `b` were placed end-on.
