---
license: other
license_name: sam-license
license_link: LICENSE
base_model: facebook/sam3.1
tags:
  - segmentation
  - micro-ct
  - medical-imaging
  - sam3
---

# Voluma plate fine-tune: SAM 3.1 for the mouse tibial growth plate

Fine-tuned checkpoints of Meta's SAM 3.1 image model that find the growth plate in coronal sections of micro-CT scans of
mouse knees. They are built and scored by the code in
[voluma-bio/voluma, `training/plate-finetune/`](https://github.com/voluma-bio/voluma/tree/main/training/plate-finetune), which
also has every method we tried and how to reproduce these numbers.

Each file holds only the tensors we trained (LoRA rank 16 on the ViT attention, plus the neck, fusion encoder, decoder and heads)
and the LoRA rank. Load it on top of the SAM 3.1 weights from [facebook/sam3.1](https://huggingface.co/facebook/sam3.1)
(`sam3.1_multiplex.pt`), which you get from Meta under the SAM License; `model.build(ckpt=...)` in the repo does this.

## Checkpoints

| File | Prompt | Target |
|---|---|---|
| `band-s0.pt`, `band-s1.pt`, `band-s2.pt` | `growth plate` | the plate: from the proximal to the distal face, plus the cut line dilated by 1 voxel |

This repository holds the three band checkpoints. The region checkpoints (prompt `epiphysis`, the epiphysis above the
cut line), scored below for comparison, are not published here.

Three seeds per target, each the checkpoint with the lowest validation loss of a 3000-step run. The released recipe is the
three band seeds, which is also what Voluma's staging production service uses:
- predict each at detector threshold 0.3 (`predict.py --threshold 0.3`);
- take each section's cut line from the midline between the band's two faces (`band_to_region.py`, the default);
- vote the three regions (`vote.py --abstain`; at 0.3 it equals the plain vote).

The inference code is in the private Voluma repository at
[`training/plate-finetune/`](https://github.com/voluma-bio/voluma/tree/main/training/plate-finetune).
After obtaining the SAM 3.1 base weights under the SAM License and setting up the lab scan inputs, clone that repository,
run `uv sync`, and use the release commands in its README: run `predict.py` once for each `band-s0.pt`, `band-s1.pt`,
and `band-s2.pt` with `--text "growth plate" --threshold 0.3`, convert each with `band_to_region.py`, and combine them
with `vote.py --abstain`. This public repository contains no scan data.

## Training data

Coronal sections of 31 micro-CT scans of mouse knees (10.5 µm voxels) from the Yao lab's osteoarthritis scans, including OA6-2RK: 460 training
sections, 58 validation sections from 4 further scans, 29 test sections from 2 more. The labels are cut lines through the
centre of the growth plate, derived from the two plate faces that AI agents traced. Only the test scan OA8-19L was reviewed: an
expert corrected 12 of its 14 lines and passed the other 2. Every other label, training ones included, is the agent's trace. Fibula, loose bone and ossicles on the plateau are ignored in the loss. The scans themselves are not
public. The lab has agreed to these weights being public.

## Metric and results

The cut-line distance, median per section in µm: per section, the median distance between the label's cut line and the cut
line the prediction implies, then the mean over sections. A section with no prediction scores 1050 µm.

| | OA8-19L (test, expert lines) | OA6-9RK (test, agent lines) | 4 validation scans |
|---|---|---|---|
| region, per seed | 33.4 ± 5.5 | 53.5 ± 38.0 | 55 / 54 / 32 |
| region, 3-seed vote | 33.8 | 33.1 | 34 |
| band, per seed | 16.1 ± 2.1 | 20.0 ± 3.4 | 39 / 26 / 32 |
| **band, 3-seed vote (recommended)** | **16.4** | **18.7** | 33 |

The band rows use threshold 0.3 and the midline cut. Both, and the vote, were fixed on the validation scans before the test scans
were scored. The face rule was revisited after test scoring: the midline uses the band's own faces rather than the
probability-snapped faces chosen on validation, and the plain faces also score better on validation (33.9 vs 34.6 µm). A perfect band scores about 11 µm through the same line extraction (the label floor). The band's two faces land
within 1–2 voxels of the traced faces (median error 11–26 µm per scan and seed).

## Intended use

Research measurement of the growth plate in micro-CT of mouse knees prepared the way these were (the tibia on its own
resampled grid, coronal sections, HU windowed to [-1000, 7000]): the cut line as a starting point that a person or a checking
agent reviews, as in Voluma's mouse OA workflow. Not for clinical use, and not for human or other species' bone.

## Limits

- Trained on one lab's scans and scanner. Untested on other protocols, ages or resolutions.
- At the detector's default threshold 0.5 a band seed returns nothing on about one section in twenty, and an empty section
  has no cut line. At 0.3 none of the 261 section-predictions on the six scored scans was empty. A new scan may still have
  some, and the abstain vote then skips that seed.
- Two test scans and four validation scans are few. On one validation scan (OA8-21L) the band vote is worse than the region
  vote (52.5 vs 38 µm).
- On end sections where the plate covers only part of the section, the band model can draw a full-width line through other bone;
  it can also mark a separate round bone that the line extraction then joins to the plate.
- Thickness from the band is good to about ±1 voxel and comes out about one voxel thicker than traced where the plate is thin.

## Licence

These checkpoints are derivative works of SAM 3.1 and are distributed under the SAM License, a copy of which is in
[LICENSE](LICENSE), as its §1.b.i requires: any further distribution of them, or of works derived from them, must be under the
same terms with a copy of the licence. Research that uses them must acknowledge the use of SAM (§1.b.ii). The SAM License's
use restrictions (§1.b.iii–v) apply.

SAM 3.1 is by Meta AI Research: [facebookresearch/sam3](https://github.com/facebookresearch/sam3),
[facebook/sam3.1](https://huggingface.co/facebook/sam3.1).
