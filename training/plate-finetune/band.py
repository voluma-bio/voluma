"""Build the band training set from a region export: the same images and label arrays, a growth-plate band as the target.

  python band.py --src data/region --out data/band

Each split's _annotations.coco.json is rewritten from <split>/labels/<scan>.npz: band = per U column the voxels from the proximal to
the distal traced face (cutline.face_rows), plus the label cut line dilated by 1 (covers the steep ends, where a column has no face
rows, and a reviewer-fixed cut), inside the whole mask's envelope, outside ignore. Sections without traced faces (reviewer-fixed
only) get the cut line dilated by NO_FACES_R. img/, labels/ and meta.json are relative symlinks into --src, so scoring still sees
the region label and the two sets must sit side by side. Prompt "growth plate".
"""
import argparse
import json
import os
from pathlib import Path

import numpy as np
from pycocotools import mask as mu
from scipy.ndimage import binary_dilation
from skimage.morphology import disk

import cutline
import scans
from export import SIZE, pad_mask, rle_of

NO_FACES_R = 3
TEXT = "growth plate"


def band_of(v, curves, cut, ign, env):
    """-> (band (W, U) bool, whether the section has traced faces)."""
    near = binary_dilation(cut, disk(1))
    if v not in curves:
        return binary_dilation(cut, disk(NO_FACES_R)) & env & ~ign, False
    n_w, n_u = env.shape
    top, bot = (cutline.face_rows(c, n_u) for c in curves[v])
    rows = np.arange(n_w)[:, None]
    lo, hi = np.fmin(top, bot)[None], np.fmax(top, bot)[None]
    between = (rows >= np.round(lo)) & (rows <= np.round(hi))
    return (between | near) & env & ~ign, True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True, type=Path, help="a region export (export.py)")
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--text", default=TEXT)
    a = ap.parse_args()
    for split in ("train", "val", "heldout"):
        src, dst = a.src / split, a.out / split
        dst.mkdir(parents=True, exist_ok=True)
        for sub in ("img", "labels", "meta.json"):
            if not (dst / sub).exists():
                os.symlink(os.path.relpath(src / sub, dst), dst / sub)
        coco = json.loads((src / "_annotations.coco.json").read_text())
        lab = {}
        for p in (src / "labels").glob("*.npz"):
            z = np.load(p)
            for i, v in enumerate(z["V"]):
                lab[f"{p.stem}_V{int(v):03d}.png"] = (p.stem, int(v), z["ignore"][i], z["cut"][i])
        curves = {}
        images, anns, nofaces = [], [], 0
        for im in coco["images"]:
            scan, v, ign, cut = lab[im["file_name"]]
            if scan not in curves:
                curves[scan] = scans.load_curves(scan)
            env = cutline.envelope(scans.load_tibia_mask(scan)[:, v, :])
            band, ok = band_of(v, curves[scan], cut, ign, env)
            nofaces += not ok
            s = SIZE / max(band.shape)
            big = pad_mask(band, s)
            if not big.any():
                continue
            rle = rle_of(big)
            rle["ignore"] = rle_of(pad_mask(ign, s))
            k = len(anns) + 1
            images.append(im)
            anns.append({"id": k, "image_id": im["id"], "category_id": 1, "segmentation": rle, "iscrowd": 0,
                         "area": float(mu.area(rle)), "bbox": [float(x) for x in mu.toBbox(rle)]})
        (dst / "_annotations.coco.json").write_text(json.dumps({"images": images, "annotations": anns, "categories": [{"id": 1, "name": a.text}]}))
        print(split, len(coco["images"]), "images", len(anns), "instances;", nofaces, "without traced faces")
    sp = json.loads((a.src / "split.json").read_text())
    (a.out / "split.json").write_text(json.dumps({**sp, "target": "band", "text": a.text}, indent=1))


if __name__ == "__main__":
    main()
