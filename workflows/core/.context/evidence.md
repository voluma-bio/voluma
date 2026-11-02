# Evidence behind the skills' rules

The skills are prompts and carry rules, not their history. This page keeps the measurements a rule came from, so whoever
revises a rule can judge whether it still holds. Every number is from one scan (OA6-1RK, 0.0105 mm isotropic) unless it says
otherwise; the recipe was last measured 2026-10-28, with two public femurs for `sam-segmentation`. Nothing here is read by a
run agent.

## orient-joint

- Tracking along the scanner's axis lost a bone at the growth plate: the epiphysis was covered 5% and 34% on two public scans,
  against 97-99% on the oriented stack.
- Short fields, OA6-1RK: the bones' elongation measures 2.38 (needs 2); the femur shaft reaches 3.6 radii. Cropped to z 120:877
  it reaches 1.0 radius and the bend reads 45 degrees instead of 64; cropped to z 80:877 (2.9 radii) it reads 75. A field of
  the bone ends only (largest piece elongation 1.24) has no shaft. Cropped OA6-1RK (z 180:400, 200:380, :500, 300:) stops with
  "No shaft in the field".
- `--second-bone-frac`: a tibia holding 50% of the femur's voxels is found; the OA6-1RK patella is 8%; a 19% stub needed 0.15.
- On a field with no patella a 311k-voxel piece, probably the fibula head, became the reference object; the keyframe still cut
  both bones.
- A round trip scan -> stack -> scan with nearest neighbour costs about 1% Dice (0.990-0.995 per bone). `map_points.py --pieces`
  boxes for three candidates were within 1-2 px of the reference labels' extent on the same slice.

## sam-segmentation

- Hand-drawn boxes cut 14-20 px off bone edges (patella front, tibia); snapped boxes (+3 px) landed within 3 px.
- Unclipped SAM mask of the patella 16 mm³, its bone 2.5 mm³.
- Repair log on the clipped SAM labels: femur 3 pieces (extras 0.29 and 0.12 mm³), patella 2.53 mm³ in 14 pieces, fibula 2.00 mm³
  in 4 pieces (a 0.64 mm³ piece was tibia; with only a tibia seed, 0.42 mm³ of tibia stayed in it). After repair: femur 8.06,
  tibia 6.81, patella 1.43, fibula 0.98 mm³, the fibula with a 0.06 mm³ second piece left.
- On a field with no patella, a box on a small anterior piece returned a 0.06 mm³ sesamoid called "patella".
- Small structures in the big-bone request cost the patella: Dice 0.95 to 0.86 (the track loses frames and follows the femoral shaft).
- Trimmed small tracks run 10-20% under the reference; the trim rule (confidence 0.5, unbroken run) was set on this one scan.
  In the experiment a three-piece structure leaked into the patella; "big bones win overlaps" was added for that and never tested.
- Overlap rule of `merge_labels.py`, tested 2026-11-02 on the saved two-request SAM output of both scans (domain HU >= 2500, Dice against
  OA6's review-07 labels; OA7 has no reference, so classic labels stand in, which are not ground truth). Rules: big wins / small wins / nearest own voxel:
  - OA7-1L (staging run 8b05ef94): SAM's femur mask covered 32% of each sesamoid. Lateral sesamoid 0.0718 / 0.1067 / 0.0930 mm3 (SAM request 0.1067),
    medial 0.0642 / 0.0942 / 0.0940; femur 11.059 / 10.994 / 11.008. Against classic, lateral Dice 0.823 / 0.808 / 0.841, medial 0.781 / 0.966 / 0.965.
    The femur mask also sits on the lower half of the lateral sesamoid, a cut of its own that the nearest rule only halves.
  - OA6-1RK, on the oriented grid (the saved requests' own grid, not the scan grid): the patella-leaking piece (temp 63, 356,590 voxels, 335,005 of them
    kept by the patella). Patella Dice 0.941 / 0.805 / 0.942 (small wins: 2.217 -> 1.798 mm3); label 9 0.803 / 0.540 / 0.870; lateral sesamoid
    0.876 / 0.919 / 0.918; label 12 0.909 / 0.941 / 0.930. Femur and tibia move under 0.002 in every rule.
  - The nearest rule keeps the leak out because the leaking piece sits inside the patella, so the patella's own voxels are nearer to the
    contested voxels; the same rule gives a sesamoid its voxels where the femur claim is a thin slab over it. It names no anatomy, and a
    leak that covers a whole big label hands that label over whole (`big_lost` shows it).
  - Memory: 1.8 GB peak on OA7-1L (277M voxels, 10 s), 2.3 GB on OA6-1RK (311M voxels), about 7 bytes per voxel; the sandbox has 8 GiB.
- Repeat requests on one stack agreed at Dice 0.994-0.998.

## segmentation-check

- On OA6-1RK the four biggest `unlabelled.py` candidates sit at the scan edge and are not knee labels.
- Classic labels grown from SAM's femur, tibia and patella alone agreed with the reference at Dice 0.92 / 0.90 / 0.92, against
  SAM's 0.97 / 0.95 / 0.94, because the fibula and the small bones were unlabelled and the watershed absorbed them.
- Disagreement region 2 (4,849 voxels, 0.006 mm³) is 0.1% of the femur's range width and 1.5% of the sesamoid's; region 1 in the
  same run ran the other way (yours = lateral-sesamoid, classic = femur, 0.01 mm³).
- An earlier validator flagged 5.4% of the watershed's bone for SAM's labels; `disagree.py` on the same run, big bones only, flags 2.6%.
- A watershed restricted to the label split a tibia label that had swallowed the fibula back to Dice 0.998 (tibia) and 0.987 (fibula).

## regions-and-landmarks

- `pick.py` surface picks agree with a VTK cell picker on the same render to within 1-2 voxels.
- `region_from_curves.py between`, fed the old run's growth-plate face and traced boundary, rebuilt the old tibial trabecular
  ROI: 1,130,584 voxels against 1,129,591 (0.09% more, all extra).
- The Amira landmark layout follows the open-source writer in R's `nat` package and was never opened in Amira.

## bone-morphometry

- The sphere method rounds radii to half a voxel: on a trabecular ROI 6-7 voxels thick it read +8-9% (72.4 against 66.8 um for
  the same mask upsampled 2x).
- Tb.Nd and Tb.Tm were checked only on a synthetic cross (1 node, 6 ends). In a slab 19 voxels thick the interior left after
  the edge margin is under half of the ROI.

## visual-check

The "What your eyes are good for" rules come from 16 model calls on OA6-1RK (design doc "What the model's eyes can do"); all n=1.

- The 3D sheet caught a tibia label covering the fibula and small fragments merged into the femur in 4 of 4 cases.
- 2D overlays caught a leak across the joint and an unlabelled patella (2 of 3 tests); one of two models put a small
  wrong-label fragment about 150 px from where it was.
- Away from the joint, on a single slice, both models called the tibia the femur and the fibula the tibia.
- Boxes read by eye were off by up to about 55 px on a 928 px slice (one model; the other was within 5 px on big bones, worse on the patella).
- Flexion read off renders came out 10-38 degrees against a measured 64 (the renders were not true lateral views).
- A model described a bone rotating into view in a video whose frames were identical.
- One model called a small posterior piece a fabella on every overlay, the other on the keyframe: unconfirmed.
- A 6-view 3D sheet of OA6-1RK is about 190 KB.
