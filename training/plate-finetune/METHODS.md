# Methods tried for the growth-plate cut line

Every method we trained or tried for finding the growth-plate cut line in micro-CT mouse-knee sections, with a short explanation and its result, including the ones whose code this repo does not carry. The number quoted everywhere is the cut-line distance, "median/section" in µm (the mean over sections of each section's median distance from the label cut line to the predicted region's cut boundary; a section with no prediction scores 1050 µm), on the test scan OA8-19L with expert-corrected labels; any entry that used a different metric, scan or label version says so. The current recipes and their scores are in [README.md](README.md).

## Summary

Best OA8-19L median/section per method. "Comparable" means the same metric and scan on the current protocol; see the entries for the caveats behind each number.

| Method | Experiment | Median/section (µm) | Comparable | In the repo |
|---|---|---|---|---|
| Zero-shot SAM 3.1 | L9, L13 | no prediction (Dice 0) | yes | no |
| Frozen-only fine-tune | L13 | 40 | yes, old labels | no |
| LoRA r16 / r64, early labels | L13 | 31 / 25 | yes, old labels | rank 16 only |
| Recipe A, 8 scans (3 seeds) | L15, L16 | 32.3 ± 6.3 | yes | yes |
| Recipe A, all traced scans (3 seeds) | L29 | 33.4 ± 5.5 | yes, new label rules | yes |
| Recipe A, 6-model vote (A + ZH) | L29 | 28.7 | yes, new label rules | no (A votes only) |
| Halves crop (ZH), 8 scans (3 seeds) | L18 | 30.0 ± 1.6 | yes | no |
| 2.5D context | L16 | 38.4 ± 3.7 | yes | no |
| Cut-band loss weight | L18 | 33.6 ± 1.7 | yes | no |
| Public knees added (PUB) | L32 | 64.6 ± 52.3 (vote 39.9) | yes, new label rules | no |
| **Band target, threshold 0.3, 3-seed vote, cut on the faces' midline** | L33 | **16.4** | yes, new label rules; every rule fixed on validation first | yes (the release recipe) |
| Band target, threshold 0.3, 3-seed vote, cut on the skeleton line | L33 | 17.6 | yes, new label rules; fixed on validation first | yes |
| Band faces snapped on the band probability, midline cut | L33 | 15.9 | yes, new label rules; fixed on validation first | no |
| Stray-piece rules on the band (12 rules) | L33 | none beat no rule on validation | validation only | no |
| Band target, threshold 0.5, 3-seed vote, empty abstains | L32 | 16.7 | yes, new label rules; vote rule chosen after seeing the scores | yes (threshold 0.5) |
| Band target, threshold 0.5, 3-seed vote, plain majority | L32 | 92.3 | yes, new label rules | yes (threshold 0.5) |
| Band target + neighbour fill, 1000 steps | L21 | 34.9 ± 4.5 | yes, L15 labels | no (fill) |
| Two-region target + fill | L21 | 31.5 ± 6.7 | yes, L15 labels | no |
| Stock SAM 3.1 tracker between keyframes | L17 | 52 to 58 (agent keyframes) | yes, 11 to 12 sections | no |
| Linear interpolation of the cut | E1, L15, L17 | 26 to 29 (skip 1) | yes, 11 to 12 sections; E1's own table used the outline metric | no |
| SAM click snap on interpolated line | L19 | 54 to 63 | yes, 8 to 12 sections | no |
| Classical snap | L22, L25 | 19 to 20 (from interpolation 26) | yes, but tuned while looking at OA8-19L | no |
| Opus agent traces | L13, L15 | 15 | yes | no |
| Spark 1.3 Contributor, images | L22, L23 | 116 | yes | no |
| Spark with text tools (3 arms) | L23 | 82 to 89 | yes | no |
| MedSAM3, no training | MedSAM3 | 445 (text), 439 (box) | yes | no |

Seed noise matters when reading the table. Recipe A on the same data and scan ranges from 27 to 39 µm across three seeds, and from 27 to 104 across seven. Two single-seed numbers say nothing about which method is better; L20 estimates that 4 to 5 seeds per variant resolve differences above about 10 µm at best. The label rules changed three times: L9 (open ends no longer leak, satellite bone pieces ignored), L15 (pockets filled, loose bone ignored, connector stretches no longer scored) and L29 (fibula, loose bone and plateau pieces ignored). Numbers before and after those changes are not strictly comparable.

## Fine-tune variants (region target)

The image model is SAM 3.1, prompted with the text "epiphysis". The label is the region above the cut line, and the cut line is read off the predicted region's boundary.

**Zero-shot SAM 3.1 (L9, L13)**
Stock weights. Nothing is predicted at threshold 0.5 with the prompts "epiphysis" (L13) and "bone" (L9), and nothing at 0.05 with "epiphysis", "bone" or "growth plate" on four checked sections. Dice 0 on OA8-19L.
Not carried: it is only the baseline.

**Frozen-only training (L9, L13)**
ViT trunk and text encoder frozen, neck, fusion, decoder and heads trained (40.5M parameters). On OA8-19L, trained on the pre-L15 labels and re-scored on the L15 labels: 40 µm (L13 re-score), against 31 for LoRA r16 (one seed each). L9 (outline metric, mean, two held-out scans, preliminary labels; different metric, not comparable) also had frozen behind LoRA: cut mean 183 vs 166 µm.
Not carried: LoRA was better and costs only about twice the time per step.

**LoRA r16 and r64, early labels (L9, L13)**
LoRA on the ViT attention qkv/proj on top of the trained heads. L13 re-scored on the L15 labels (the models were trained on older labels): r16 31 µm, r64 25 µm, r16 with smoothing 33 µm, one seed and 14 sections each. r16 and r64 are not meaningfully different on one scan. L9's original numbers use the outline metric (mean, two scans) and are not comparable.
In the repo: rank 16 (it is the recipe below). Not carried: rank 64.

**Recipe A, 8 scans (L15, L16, L20)**
LoRA r16, 1000 steps, best-validation checkpoint, region target on the L15 labels. One seed gave 27 µm (Dice 0.915); three seeds gave 32.3 ± 6.3 (range 27 to 39); seven seeds gave a median of 35 and a mean of 43 ± 27, because seed 3 missed the sliver section V34 (1050 µm). Moving the L15 labels from the L13 ones took one seed from 31 to 27, within seed noise.
In the repo: the recipe, at 3000 steps on all scans (next entry).

**Recipe A, all traced scans (L29)**
The same recipe at 3000 steps on every other traced lab scan (31 scans), validated on four held-out scans, tested on OA8-19L (expert lines) and OA6-9RK (agent lines, not expert). OA8-19L: 33.4 ± 5.5 over 3 seeds, Dice 0.889; OA6-9RK: 53.5 ± 38.0. This does not beat 8 scans (33.0 ± 9.4), though the label rules and step count also changed, so it is not a pure data-size comparison. The seed spread is set by single-section misses.
In the repo.

**Votes over several models (L29, L32)**
A voxel is kept when at least half the models have it. Over the 3 recipe-A seeds: 33.8 on OA8-19L, 33.1 on OA6-9RK. A 6-model vote (3 recipe A, 3 ZH) gave 28.7 on OA8-19L (Dice 0.900), the best region-target number. The "empty abstains" rule (a model with no mask on a section does not vote) leaves recipe A unchanged and matters for the band target (see below).
In the repo: plain majority and "empty abstains". Not carried: the mixed A + ZH vote, because ZH is not carried.

**Halves crop, ZH (L18, L29)**
Crop to the plate rows and split into two overlapping halves in U, so a mask pixel covers 0.78 voxels instead of 1.36. With 8 scans: 30.0 ± 1.6 (3 seeds), with a much tighter seed spread and a better p95 than A, but it loses the V34 sliver and has lower Dice (0.860 vs 0.899). With all traced scans (L29, 3000 steps): 76.8 ± 39.7 on OA8-19L (misses of about 100 µm in two of three seeds), 28.9 ± 4.7 on OA6-9RK; better than A on some scans and much worse on others.
Not carried: scan-dependent, and not safe alone. It helped as a voter in the 6-model vote.

**Rows-only crop, Z (L18)**
Crop to the plate rows, no halves: 33.7 ± 3.8, inside A's seed spread. The end section V262 got worse.
Not carried: no gain.

**Cut-band loss weighting (L18)**
Pixels within 4 voxels (42 µm) of the cut line get loss weight 5. Weight alone: 33.6 ± 1.7; with crop 37.8 ± 3.7; with halves 31.9 ± 0.9. No effect beyond noise.
Not carried: no gain.

**2.5D context (L16)**
The input channels are sections V-k, V and V+k. Three seeds at k=4 gave 38.4 ± 3.7 against A's 32.3 ± 6.3; k=2 (one seed) gave 33.5. The fragment section V34 did not improve and the end section V262 got worse.
Not carried: no gain.

**Public knees added to training (L32 PUB)**
Recipe A plus 8 public knees (117 public images, 3-week knees at weight 0.3), L29 label rules, 3000 steps. OA8-19L: 64.6 ± 52.3 over 3 seeds, 3-seed vote 39.9 (A's vote: 33.8); OA6-9RK vote 37.9 against 33.1. Equal to A within seed spread everywhere, better nowhere.
Not carried: did not beat A.

**Learning curve on data size (L26)**
Recipe A on 2, 4, 6 and 8 training scans, 1000 steps, L15 labels, 3 seeds: 66.8 ± 34.4, 61.4 ± 8.3, 64.7 ± 42.8 and 33.0 ± 9.4 µm. Dice climbs steadily (0.816 to 0.877); the median is flat then drops at 8, and the spread at small n is set by single misses. The L29 result above suggests the curve flattens at about 33.
Not a method.

## Line and band targets

Instead of the region above the line, the model predicts a thin band along the cut line, and a line is read off it.

**Band target, label cut line dilated by 3 voxels, with neighbour fill (L21)**
Prompt "growth plate". The skeleton of each predicted piece gives a path, pieces are chained left to right, gaps of up to 25 voxels in U are bridged, and a section without a complete line takes the missing stretch from interpolating neighbouring complete sections. On OA8-19L (L15 labels, 1000 steps, 3 seeds): 34.9 ± 4.5, Dice 0.923, p95 167 against A's 220. Without the neighbour fill: 54.9 ± 38.8, because one seed's detections stopped at V246 and left V262 empty. The fill setting (copy from the nearest complete section within 20 sections) was set after seeing that failure; with 8 it scored 56.8.
In the repo: the band-to-line-to-region conversion with the skeleton and chain line extraction, without the neighbour fill. Not carried: the neighbour fill.

**Two-region target, "epiphysis" and "metaphysis" (L21)**
Two instances per image; the cut is the midline between the two predicted masks. With fill: 31.5 ± 6.7, Dice 0.933, p95 143. Without fill: 32.8 ± 8.5. Similar median to the band, a better p95, and less need for fill; the two are not separable on three seeds.
Not carried: no clear gain over the band target.

**Band target, traced faces plus cut line (L32 BAND)**
The band runs from the proximal to the distal traced face, plus the cut line dilated by 1. L29 label rules and split, 3000 steps. The line goes through the conversion above without neighbour fill, then into the L29 region rule. The per-seed numbers look worse than A (OA8-19L 90.2 ± 74.4) because on 14 of 261 sections a seed outputs no mask (A: 2) and each scores 1050. One seed with no empty sections scored 14.9 on OA8-19L, the best single model.
In the repo: the band target.

**Votes with empty sections abstaining (L32)**
At threshold 0.5, treating an empty mask as an abstention instead of a "no" vote, the 3-seed band vote is 16.7 µm on OA8-19L (A's vote 33.8, the 6-model A + ZH vote 28.7), p95 94, and 22.1 on OA6-9RK (A 33.1), p95 116. It is worse on validation scan OA8-21L (66.1 vs 38.3). The rule was chosen after seeing the empty sections. L33 checked that validation alone would have chosen it too (pooled validation 39 µm against 99 for the plain vote). The plain majority vote gave 92.3 on OA8-19L. L33's lower threshold makes the two rules equal.
In the repo: both vote rules.

**Band face and thickness errors (L32)**
Faces read from the band lie within 10 to 23 µm of the traced faces on the six scans, and the band comes out about one voxel thicker than traced where the plate is thin. Thickness is usable to about plus or minus 1 voxel.
In the repo.

**Lower threshold for empty sections (L33)**
The L32 band checkpoints, unchanged, with the detector's instance-score threshold lowered. L33 fixed every rule on the four validation scans before scoring the test scans, and scored each test scan once per step. Pooled validation vote (mean of the 4 scans): 0.5 39.0, **0.3 37.8**, 0.2 47.3 (OA8-21L gets much worse at 0.2). Keeping 0.5 and falling back to 0.3 or 0.2 only on an empty section, or taking an empty section's best instance whatever its score, scored 38.0 to 52.6. At 0.3 no section is empty on any scan or seed (at 0.5: 14 of 261), and a single seed scores about as well as the vote: per-seed mean 17.5 µm on OA8-19L and 21.2 on OA6-9RK (at 0.5: 90.4 and 46.2). The 3-seed vote scores **17.6 on OA8-19L and 19.8 on OA6-9RK** (p95 107 and 113). L32's abstain vote, re-predicted on the same GPU, scored 17.0 and 21.5. Measured as the gain over the A vote, the threshold keeps all of L32's gain without a rule chosen on the test scans.
In the repo: `predict.py --threshold 0.3`.

**Cut line from the faces' midline (L33)**
The faces are the band's run nearest the skeleton line in each column. Each point of the skeleton line moves to the faces' midpoint where that is within 4 voxels. Pooled validation vote 33.9 µm against 37.8 for the skeleton line. Test: 16.4 on OA8-19L, 18.7 on OA6-9RK (skeleton 17.6 and 19.8).
In the repo: `band_to_region.py`, the default cut.

**Faces snapped on the band probability (L33)**
The faces were moved by snap_faces' two-face search with the cost taken from the band's soft probability, from the HU image, from both, or from the probability's half-maximum crossings. One variant added a pull toward the neighbouring sections' faces. Pooled validation mean face error: plain 38.0 µm, probability 38.0, probability + neighbours 37.1, HU 40.4, both 40.0, half-maximum 38.9. The probability + neighbours variant was chosen on validation. On the test scans its faces were no better than the plain ones (mean error 23.6 vs 20.7 µm on OA8-19L, 25.3 vs 25.6 on OA6-9RK). Its midline cut scored 15.9 and 19.7 against the plain faces' 16.4 and 18.7. The probability snap stays on the plain band edges because the probability already falls there; medians are 12 to 16 µm (just over a voxel) for every mode, and the error is in a few sections per scan more than 50 µm off.
Not carried: no gain over the plain faces.

**Stray-piece rules (L33)**
Twelve rules that drop band pieces before the line is chained, at threshold 0.3, validation only:
- keep the widest piece and anything within 5, 10 or 20 voxels of it;
- keep pieces within 6, 10 or 15 voxels of the neighbour sections' line;
- keep pieces supported by at least half of the neighbour sections (3D support);
- cut the chain at bridges with a W jump over 10, 20 or 30 voxels (tried after the test scans were scored).

None beat "no rule" (pooled validation 37.8 µm); all did worse (54 to 91): on end sections with a partial plate the widest piece is other bone, and dropping the rest drops the plate (OA8-21L V75: 15 to 1050 µm). 3D support keeps the strays, because they persist across neighbouring sections. The cut-line score barely sees strays, because it scores only the label's columns.
Not carried: no gain.

## Tracker propagation

**Stock SAM 3.1 tracker between agent keyframes (L17)**
The region above a keyframe's cut is the seed, propagated up and down, and the two tracks are blended. Scored on 11 to 12 OA8-19L sections (the sections between keyframes, so not the full 14). With agent keyframes, skip 1: 58 µm (52 with hole filling) against 26 for linear interpolation of the same keyframes; with expert keyframes 46 (40 with fill) against 29. It is better only at plate ends (V34 42, V262 89, where interpolation cannot score) and on the split section V46 with expert keyframes (32 vs 103). Cost is about 18 s per keyframe on a 3090.
Not carried: worse than interpolation, which is also cheaper. A line fitted through the tracked boundary was not tried.

## Interpolation

**Linear interpolation of the cut line between traced sections (E1, L15, L17)**
Two cuts are blended point by point along a length parameter; the region is built from the interpolated cut like any label. E1's own table uses the older outline metric (OA8-19L, skip 1: 26 µm median) and is not comparable. Re-scored with the cut-line metric on OA8-19L (L15): skip 1 (neighbours about 18 sections away) 29 µm on 12 sections, skip 2 36 µm on 11; with agent keyframes (L17) 26 and 36. That is about the same as the detector's 27 to 39 across seeds. Interpolation cannot reach the first and last sections (it only fills between traced ones), and it fails where the bone splits (V46, 74 to 105 µm).
Not carried: interpolation is a way to get more labels or fill sections, not part of the pipeline here.

**Densified training sections, recipe B (E1 densify, L15)**
Interpolated sections every 6 sections between traced sections at most 20 apart, weighted by a confidence times 0.5 (129 extra sections on top of 96). OA8-19L, one seed: B 33 against A 27 (Dice 0.876 vs 0.915), with B's p95 better (163 vs 216). The gap is two or three sections, and A's seed spread (27 to 39) covers it.
Not carried: neutral at twice the data.

## Snap

A rough line (interpolated, or from another model) is moved onto the plate.

**Snap with SAM 3.1 click prompts (L19)**
Positive and negative click points on either side of the interpolated line, with an optional box, through the stock tracker heads; the mask edge is turned back into a line. 12 variants, four keyframe settings, 8 to 12 sections each. Best variant 54 to 63 µm against 26 to 36 for interpolation alone, in every setting. The best variant was picked on this same scan, so the number flatters snapping. It helped only on the split section V46 (74 to 38 µm); the mask covers the whole plate, so its edge sits a consistent few voxels below the cut. The image model's own interactive predictor could not be used because the released checkpoint does not load its neck weights.
Not carried: worse than interpolation.

**Classical plate snap, minimum-cost path (L22)**
A minimum-cost path through a cost image of dark-valley and two-sided-brightness evidence, searched in a band around the rough line. On OA8-19L (cut mode): interpolation from agent keyframes 26 to 19 µm, an expert line shifted 10 voxels 83 to 95 down to 27 to 30, shifted 15 voxels 141 to 151 down to 77 to 79; the agent line 15 to 17; the Spark trace 116 to 79; the LoRA cut edge 39 to 39. Capture range is about 10 voxels (105 µm). OA8-19L was looked at about eight times while building it, so treat the numbers as slightly optimistic. A faces mode (two faces) was also tried; on a product run's real faces on another scan (OA6-2RK, scored in voxels against agent faces, not this metric) it fixed only the half of the points already near the plate.
Not carried: it helps only a line already within about 10 voxels, and it leaves a good line unchanged at best.

**Confidence-weighted smoothing of the snap (L25)**
Blend the snapped path toward the rough line by confidence, and smooth offsets across sections. The blend halves the snap's own noise (on an expert line, 10.0 to 5.6 µm typical movement); on OA8-19L the agent line scored 15 (unchanged from 15) and interpolation 26 to 20, against L22's 19. Smoothing across sections gave nothing. Faces from a centre line (a DP seeded at the centre plus or minus 3 voxels) landed within 1 voxel median of the agent faces on OA8-19L, but the thickness is mostly the prior.
Not carried: no gain beyond L22's.

## LLM tracers, including text instead of pixels

**Opus agent traces (L13, L15)**
A coding agent looks at images of each section and records the two faces and the ends; this produced the training labels. On OA8-19L its line scores 15 µm (Dice 0.982, 14 sections). The expert then edited a few voxels of most of these lines, so this measures agreement with a lightly edited copy, not independent accuracy; the expert-vs-agent gap is about the size of the model's own error.
Not carried.

**Spark 1.3 Contributor, images (L22, L23)**
The same tracing task given to the Meta model Muse Spark 1.3 Contributor with images: 116 µm on OA8-19L (Dice 0.855), 55 minutes. It fails at the plate ends (V244 277, V262 409 µm).
Not carried.

**Spark with text tools instead of pixels (L23)**
Three arms, same briefs, thinking high. The tools print the section as numbers: per-column intensity profiles with valley candidates (T, text only), the same plus image reading (TI), and a voxel-by-voxel grid plus a 3D Hessian sheet filter (TG, text only). Median/section on OA8-19L: T 82.1 µm (Dice 0.665), TI 89.4 (0.851), TG 89.1 (0.767). The curves land on valleys to the voxel and the middle sections are good (13 to 50 µm), but all three fail at the posterior end (V226 to V262: 120 to 350 µm) because nothing in the numbers says which dark structure is the plate. Cost was $0.09 to $0.24 per arm.
Not carried.

## MedSAM3

**MedSAM3, out of the box (MedSAM3)**
A SAM 3 base (not SAM 3.1) with a medical LoRA, run unmodified on the same 14 OA8-19L sections with the same metric. Text prompts: "epiphysis" 445 µm (Dice 0.158), "bone" 520, "cartilage" 616, "growth plate" 758, "physis" 846, "epiphyseal plate" 749. An expert box with "growth plate": 439 µm (Dice 0.368), still blank on four sections. At threshold 0.05 the best text prompt reaches 92 µm. It segments marrow cavities and background blobs, not the plate. Its adapters sit on a different base and different modules than ours, so they cannot be merged with the LoRA here.
Not carried: it does not find the plate, and training on it is not defined on the current stack.

**Box prompts (MedSAM3, L19)**
An expert box added to the text prompt. At threshold 0.5 it was the best MedSAM3 setting (439 µm against 445 for "epiphysis" alone); at 0.05 the "growth plate" text alone was best (92) and the box gave 109. In the L19 snap it helped the SAM mask. The models here train on text prompts only.
Not carried.

## Label fixes and other pieces

**Label clean-up (L9, L15)**
L9 fixed open ends so the flood fill no longer leaked into the metaphysis and ignored satellite bone pieces. L15 filled pockets, sent loose bone pieces to ignore, and scored the cut from the line's voxels inside the envelope instead of the outline (so split-section connectors are no longer scored). 14 of 134 exported sections changed. Re-training on the fixed labels removed the predictions of ossicles above the joint (recipe A in place of the L13 run, V34 Dice 0.22 to 0.86 for one seed). Numbers before and after are not strictly comparable.
In the repo: through the L29 label rules in the export (next entry).

**Plateau pieces, ossicles (L24)**
Bone pieces on the plateau that touch the tibia, found by a thin dark seam and a blocky shape, then reviewed by eye: 14 pieces over 8 of 10 scans by the write-up's summary (its table marks 13 kept over 7 scans, with OA6-9RK's piece unsure), 0 to 2.6% of the label region. With them set to ignore, the OA8-19L cut-line scores do not move (agent line 15.2, LoRA A seeds 26.9, 30.6, 39.3, identical to the digit) and Dice changes by 0.0005. They matter for volume measurements, which Dice and the cut line do not see.
In the repo: as part of the L29 rules (fibula, loose bone and plateau pieces to ignore).

**Stacked-cut smoothing as post-processing (L9, L13, L15)**
Median of the stacked cut over 11 neighbouring sections, then re-cut. It raises Dice by 0.03 to 0.055 (L13) but not the cut: L13 r16 went from 31 to 33 µm in the L15 re-score, and recipe A from 27 to 31 in L15.
Not carried.

**Training on Modal (L20)**
Recipe A reproduces on Modal: seed 0 scored 31 µm (Dice 0.947) against 27 locally, within the seed spread; four extra seeds 28 to 104. About $0.10 to $0.50 per run.
In the repo: a Modal launcher.

**Cut-line scorer (L15)**
Distance from every label cut voxel to the predicted region's cut-side boundary, plus from predicted boundary voxels within 30 voxels of the label cut back to it, capped at 1.05 mm; an exact match scores about 10 µm. The older outline distance (cut_um) picked up ossicles and marrow interfaces and is not a cut metric.
In the repo.
