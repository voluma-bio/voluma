"""How close a band model's two faces and thickness come to the traced plate faces.

  python faces.py --band preds/band-s0 --lines preds/band-s0-region --out scores/band-s0-faces.json

Per U column where both traced faces are defined and the traced plate is flat (|dW/dU| <= 1), the band's run (a connected vertical
run of the mask) nearest to the predicted cut line gives its top (proximal) and bottom (distal) face; errors in µm against the
traced faces, thickness = bottom - top + 1 voxels against the traced distal - proximal + 1. Per section the median over its
columns; per scan the median over sections, and how many sections have a face more than 50 µm off (a median hides them).
Sections the model missed have no line and contribute nothing, so read these numbers with the empty-section counts of score.py.
"""
import argparse
import json
from pathlib import Path

import numpy as np

import cutline
import scans

FLAT = 1.0
OFF_UM = 50


def section_faces(band, line, curves, n_u):
    top, bot = (cutline.face_rows(c, n_u) for c in curves)
    ok = ~np.isnan(top) & ~np.isnan(bot)
    slope = np.abs(np.gradient(np.where(ok, (top + bot) / 2, np.nan)))
    pc = np.full(n_u, np.nan)
    line = line[np.argsort(line[:, 1])]
    c = np.arange(int(np.ceil(line[0, 1])), int(np.floor(line[-1, 1])) + 1)
    pc[c] = np.interp(c, line[:, 1], line[:, 0])
    te, be, tp, tt = [], [], [], []
    for u in np.flatnonzero(ok & ~np.isnan(pc) & (slope <= FLAT)):
        col = band[:, u]
        if not col.any():
            continue
        rows = np.flatnonzero(col)
        runs = np.split(rows, np.flatnonzero(np.diff(rows) > 1) + 1)
        r = min(runs, key=lambda r: abs((r[0] + r[-1]) / 2 - pc[u]))
        te.append(abs(r[0] - top[u]) * scans.UM)
        be.append(abs(r[-1] - bot[u]) * scans.UM)
        tp.append(len(r))
        tt.append(abs(bot[u] - top[u]) + 1)
    if te:
        return {"top": float(np.median(te)), "bot": float(np.median(be)), "thick_pred": float(np.median(tp)), "thick_true": float(np.median(tt))}
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--band", required=True, type=Path, help="predict.py output of a band model")
    ap.add_argument("--lines", required=True, type=Path, help="band_to_region.py output for the same predictions")
    ap.add_argument("--out", required=True, type=Path)
    a = ap.parse_args()
    res = {}
    for f in sorted(a.band.glob("*.npz")):
        scan = f.stem
        z = np.load(f)
        where = {int(v): i for i, v in enumerate(z["V"])}
        lines = {int(v): np.asarray(p) for v, p in json.loads((a.lines / f"{scan}-lines.json").read_text()).items()}
        curves = scans.load_curves(scan)
        n_u = z["mask"].shape[2]
        rows = [r for v in sorted(set(lines) & set(curves)) if (r := section_faces(z["mask"][where[v]], lines[v], curves[v], n_u))]
        if not rows:
            continue
        med = {k: float(np.median([x[k] for x in rows])) for k in rows[0]}
        res[scan] = {"sections": len(rows), "proximal_err_um": med["top"], "distal_err_um": med["bot"],
                     f"sections_face_over_{OFF_UM}um": sum(max(x["top"], x["bot"]) > OFF_UM for x in rows),
                     "thickness_pred_vox": med["thick_pred"], "thickness_traced_vox": med["thick_true"]}
        print(scan, json.dumps(res[scan]))
    a.out.parent.mkdir(parents=True, exist_ok=True)
    a.out.write_text(json.dumps(res, indent=1))


if __name__ == "__main__":
    main()
