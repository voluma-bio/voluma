"""Score region predictions against an export's labels: the cut-line distance (the number to quote) and Dice.

  python score.py --data data/region --out scores/band --group "BAND=preds/band-s0-region,preds/band-s1-region,preds/band-s2-region" \
      --group "BAND vote=preds/band-vote"

Per section, cutline_distance (µm): from each label cut voxel to the predicted region's cut-side boundary, capped at CAP, plus
from each predicted boundary voxel within BAND of the label cut back to it, outside ignore voxels and columns. A section with
no prediction scores CAP (1050 µm) everywhere. Per scan: "median/section" = the mean over sections of each section's median
distance; p95 and mean pool every distance of the scan. Dice drops the label's ignore voxels; misses = sections predicted empty.
Every scan with labels in the export's heldout or val split is scored, on the sections both the labels and the prediction have.
A group is one or more prediction directories (seeds): its row shows mean ± sd (range) over them.
Writes <out>/scores.md and <out>/scores.json.
"""
import argparse
import json
from pathlib import Path

import numpy as np
from scipy.ndimage import distance_transform_edt

import cutline
import scans

BAND = 30   # voxels (315 µm): predicted boundary voxels farther than this from the label's cut line are not scored from the prediction's side
CAP = 100   # voxels: a label cut voxel with no predicted boundary nearer than this (or none at all) counts as this far
TEST = ("OA8-19L", "OA6-9RK")


def scored_lines(pred, cut, ignore, ign_cols, env):
    """-> (label cut voxels, predicted cut-side boundary voxels), both outside ignore voxels and columns: the two lines scored.
    cut: the label line's voxels inside the envelope (the export's `cut`)."""
    keep = ~ign_cols[None] & ~ignore
    return cut & keep, cutline.cut_boundary(pred & env & ~ignore, env) & keep


def cutline_distance(pred, cut, ignore, ign_cols, env):
    """Distances in voxels, both parts concatenated."""
    c, pb = scored_lines(pred, cut, ignore, ign_cols, env)
    if not c.any():
        return np.zeros(0)
    if not pb.any():
        return np.full(int(c.sum()), float(CAP))
    d_pb = np.minimum(distance_transform_edt(~pb), CAP)
    d_c = distance_transform_edt(~c)
    return np.concatenate([d_pb[c], d_c[pb & (d_c <= BAND)]])


def score_scan(scan, pred, lab):
    """pred, lab: loaded npz (prediction, export labels) -> {V: (dice, cut-line distances in µm, empty?)}."""
    tibia = scans.load_tibia_mask(scan)
    where = {int(v): i for i, v in enumerate(pred["V"])}
    rows = {}
    for v, label, ign, cols, cut in zip(lab["V"], lab["mask"], lab["ignore"], lab["ign_cols"], lab["cut"]):
        v = int(v)
        if v not in where:
            continue
        p = pred["mask"][where[v]]
        k = ~ign
        dice = 2 * (p[k] & label[k]).sum() / max(p[k].sum() + label[k].sum(), 1)
        rows[v] = (float(dice), cutline_distance(p, cut, ign, cols, cutline.envelope(tibia[:, v, :])) * scans.UM, not p.any())
    return rows


def summary(rows):
    d = [r[1] for r in rows.values()]
    pooled = np.concatenate(d)
    return {"n": len(rows), "dice": float(np.mean([r[0] for r in rows.values()])),
            "med": float(np.mean([np.median(x) if len(x) else np.nan for x in d])),
            "p95": float(np.percentile(pooled, 95)), "mean": float(pooled.mean()), "miss": sum(r[2] for r in rows.values())}


def labels_of(data, scan):
    for split in ("heldout", "val"):
        p = data / split / "labels" / f"{scan}.npz"
        if p.exists():
            return np.load(p)


def ms(xs):
    return f"{np.mean(xs):.1f} ± {np.std(xs, ddof=1):.1f} ({min(xs):.0f}–{max(xs):.0f})" if len(xs) > 1 else f"{xs[0]:.1f}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True, type=Path, help="the region export whose labels score the predictions")
    ap.add_argument("--group", required=True, action="append", help="NAME=dir,dir,...: prediction directories (one per seed)")
    ap.add_argument("--out", required=True, type=Path)
    a = ap.parse_args()
    a.out.mkdir(parents=True, exist_ok=True)
    all_scans = sorted({p.stem for s in ("heldout", "val") for p in (a.data / s / "labels").glob("*.npz")}, key=lambda s: (s not in TEST, s))
    groups = dict(g.split("=", 1) for g in a.group)
    res = {}
    for g, dirs in groups.items():
        for d in dirs.split(","):
            for scan in all_scans:
                rows = score_scan(scan, np.load(Path(d) / f"{scan}.npz"), labels_of(a.data, scan))
                res.setdefault(g, {}).setdefault(d, {})[scan] = summary(rows)
    out = []
    for scan in all_scans:
        out += [f"### {scan}{' (test)' if scan in TEST else ' (validation)'}", "",
                "| model | seeds | Dice | **cut line: median/section (µm)** | p95 | mean | empty sections (per seed) |", "|---|---|---|---|---|---|---|"]
        for g, r in res.items():
            k = [x[scan] for x in r.values()]
            out.append(f"| {g} | {len(k)} | {np.mean([x['dice'] for x in k]):.3f} | **{ms([x['med'] for x in k])}** | {ms([x['p95'] for x in k])} | "
                       f"{ms([x['mean'] for x in k])} | {'/'.join(str(x['miss']) for x in k)} of {k[0]['n']} |")
        out.append("")
    val = [s for s in all_scans if s not in TEST]
    if val:
        out += ["### Validation scans pooled (mean over the scans of each scan's median/section)", "", "| model | per seed: Dice | per seed: median/section |", "|---|---|---|"]
        for g, r in res.items():
            out.append(f"| {g} | " + " / ".join(f"{np.mean([x[s]['dice'] for s in val]):.3f}" for x in r.values()) + " | " +
                       " / ".join(f"{np.mean([x[s]['med'] for s in val]):.0f}" for x in r.values()) + " |")
    (a.out / "scores.md").write_text("\n".join(out) + "\n")
    (a.out / "scores.json").write_text(json.dumps(res, indent=1))
    print("\n".join(out))


if __name__ == "__main__":
    main()
