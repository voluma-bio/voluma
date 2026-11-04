"""Export the region training set: section images, COCO annotations (what Meta's Sam3ImageDataset reads) and label arrays.

  python export.py --split splits/v1.json --out data/region

The target is the IIOC region (labels.py): the epiphysis side of the cut line, with fibula, loose bone and plateau pieces as ignore.
Splits: train, val (every section of the split file's val scans: the validation loss) and heldout (the test scans). Each split
gets <out>/<split>/img/<scan>_V<V>.png, <split>/_annotations.coco.json (category = --text, one RLE instance per section; the
ignore voxels travel in the segmentation dict as an extra "ignore" RLE, see losses.py), <split>/meta.json (scale and grid_id per
scan) and <split>/labels/<scan>.npz (V, mask[n,W,U] region, ignore[n,W,U], cut_edge[n,U] the region's distal edge in W (NaN: no
region), ign_cols[n,U], cut[n,W,U] the cut line's voxels inside the envelope, which score.py measures to).
A section is left out when the split file drops it or its line lies mostly off the mask (labels.LINE_ON_MASK).
Image: section windowed to 8 bit, 3 channels (scans.section_img), scaled by 1008/max(W,U) with bilinear and padded bottom/right
with zeros to 1008x1008 (the model's input size; aspect kept).
"""
import argparse
import json
from pathlib import Path

import numpy as np
from PIL import Image
from pycocotools import mask as mu

import cutline
import labels
import scans

SIZE = 1008
TEXT = "epiphysis"  # the IIOC is the tibia's epiphysis (secondary ossification centre) above the plate


def pad_scale(img):
    """Native (W, U, 3) section image -> SIZE x SIZE x 3; returns (image, scale)."""
    s = SIZE / max(img.shape[:2])
    h, w = round(img.shape[0] * s), round(img.shape[1] * s)
    big = np.asarray(Image.fromarray(img).resize((w, h), Image.BILINEAR))
    out = np.zeros((SIZE, SIZE, 3), np.uint8)
    out[:h, :w] = big
    return out, s


def pad_mask(m, s):
    h, w = round(m.shape[0] * s), round(m.shape[1] * s)
    big = np.asarray(Image.fromarray(m.astype(np.uint8)).resize((w, h), Image.NEAREST)).astype(bool)
    out = np.zeros((SIZE, SIZE), bool)
    out[:h, :w] = big
    return out


def rle_of(m):
    rle = mu.encode(np.asfortranarray(m))
    rle["counts"] = rle["counts"].decode()
    return rle


def export_split(out, name, items, cuts, text):
    """items: [(scan, V)]; cuts: {scan: ({V: (cut points, gaps)}, not-visible ranges)}"""
    root = out / name
    (root / "img").mkdir(parents=True, exist_ok=True)
    (root / "labels").mkdir(exist_ok=True)
    images, anns, meta = [], [], {}
    for scan in dict.fromkeys(s for s, _ in items):
        vol = scans.load_vol(scan)
        tibia = scans.load_tibia_mask(scan)
        pieces = scans.load_pieces(scan)
        lab, nv = cuts[scan]
        masks = []
        for v in sorted(v for s, v in items if s == scan):
            r = labels.label_section(v, *lab[v], nv.get(v, ()), tibia, pieces)
            cut = cutline.wall(lab[v][0], r.env.shape) & r.env
            img, s = pad_scale(scans.section_img(vol, v))
            big = pad_mask(r.region, s)
            if not big.any():
                continue
            fn = f"{scan}_V{v:03d}.png"
            Image.fromarray(img).save(root / "img" / fn)
            rle = rle_of(big)
            rle["ignore"] = rle_of(pad_mask(r.ignore, s))
            k = len(images) + 1
            images.append({"id": k, "coco_img_id": k, "file_name": fn, "height": SIZE, "width": SIZE})
            anns.append({"id": k, "image_id": k, "category_id": 1, "segmentation": rle, "iscrowd": 0,
                         "area": float(mu.area(rle)), "bbox": [float(x) for x in mu.toBbox(rle)]})
            masks.append((v, r.region, r.ignore, r.cols, cut))
        meta[scan] = {"scale": SIZE / max(vol.shape[0], vol.shape[2]), "grid_id": scans.grid_id(scan),
                      "sections": [x[0] for x in masks]}
        np.savez_compressed(root / "labels" / f"{scan}.npz", V=np.array([x[0] for x in masks]),
                            mask=np.stack([x[1] for x in masks]), ignore=np.stack([x[2] for x in masks]),
                            cut_edge=np.stack([cutline.region_edge(x[1]) for x in masks]), ign_cols=np.stack([x[3] for x in masks]),
                            cut=np.stack([x[4] for x in masks]))
    (root / "_annotations.coco.json").write_text(json.dumps(
        {"images": images, "annotations": anns, "categories": [{"id": 1, "name": text}]}))
    (root / "meta.json").write_text(json.dumps(meta, indent=1))
    print(name, len(images), "sections from", list(meta))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--split", required=True, type=Path, help="split file: train, val and heldout scan lists, drop {scan: [V, ...]}")
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--text", default=TEXT, help="text prompt the model is trained on (the COCO category name)")
    a = ap.parse_args()
    split = json.loads(a.split.read_text())
    cuts = {}
    for scan in [*split["train"], *split["val"], *split["heldout"]]:
        sections, counts = labels.label_sections(scan)
        drop = set(split["drop"].get(scan, ()))
        mask = scans.load_tibia_mask(scan)
        off = {v for v, x in sections.items() if labels.line_on_mask(mask[:, v, :], x[0]) < labels.LINE_ON_MASK}
        sections = {v: x for v, x in sections.items() if v not in drop | off}
        cuts[scan] = (sections, labels.not_visible_ranges(scan))
        print(scan, " ".join(f"{k}={n}" for k, n in counts.items()), f"line off the mask {sorted(off)} -> kept {len(sections)}")
    a.out.mkdir(parents=True, exist_ok=True)
    for name in ("train", "val", "heldout"):
        export_split(a.out, name, [(s, v) for s in split[name] for v in sorted(cuts[s][0])], cuts, a.text)
    (a.out / "split.json").write_text(json.dumps({**{k: split[k] for k in ("train", "val", "heldout", "drop")}, "text": a.text}, indent=1))


if __name__ == "__main__":
    main()
