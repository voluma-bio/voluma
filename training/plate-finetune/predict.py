"""Predict a mask on sections of a scan with a trained checkpoint: the IIOC region (prompt "epiphysis") or the plate band
("growth plate"), whichever the checkpoint was trained on.

  python predict.py --scan OA8-19L --ckpt runs/band-s0/ckpt-bestval.pt --text "growth plate" --out preds/band-s0 \
      --sections-from data/region

Writes <out>/<scan>.npz: V (the predicted sections) and mask[n, W, U] bool on the scan's grid, the union of the detector's instances
scoring above --threshold (none: an empty section), by default the prompt's THRESHOLD. --sections-from takes the labelled
sections of the scan from an export (its heldout or val labels); without it every section is predicted.
"""
import argparse
import json
from pathlib import Path

import numpy as np
import torch
from PIL import Image
from sam3.model.sam3_image_processor import Sam3Processor

import band
import export
import model as M
import scans
from export import pad_scale

# Detector score per prompt. Band 0.3: at 0.5 a band seed returns nothing on about one section in twenty, at 0.3 on none of the
# six scored scans (L33).
THRESHOLD = {export.TEXT: 0.5, band.TEXT: 0.3}


def predict_vol(proc, vol, text, vs):
    """vol: a tibia grid's HU (W, V, U), vs: the sections to predict -> mask[len(vs), W, U] bool."""
    out = np.zeros((len(vs), vol.shape[0], vol.shape[2]), bool)
    for i, v in enumerate(vs):
        img, s = pad_scale(scans.section_img(vol, v))
        state = proc.set_text_prompt(text, proc.set_image(Image.fromarray(img)))
        if len(state["masks"]):
            m = state["masks"].any(0)[0].cpu().numpy()
            h, w = round(vol.shape[0] * s), round(vol.shape[2] * s)
            out[i] = np.asarray(Image.fromarray(m[:h, :w].astype(np.uint8)).resize((vol.shape[2], vol.shape[0]), Image.NEAREST)) > 0
    return out


def labelled_sections(data, scan):
    for split in ("heldout", "val", "train"):
        p = data / split / "labels" / f"{scan}.npz"
        if p.exists():
            return [int(v) for v in np.load(p)["V"]]
    raise SystemExit(f"{scan} has no labels in {data}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--scan", required=True, nargs="+")
    ap.add_argument("--ckpt", required=True, type=Path)
    ap.add_argument("--text", required=True, choices=list(THRESHOLD), help="the prompt the checkpoint was trained on")
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--threshold", type=float, help="instance score to keep (default: the prompt's THRESHOLD)")
    ap.add_argument("--sections-from", type=Path, help="an export: predict only the scan's labelled sections")
    a = ap.parse_args()
    a.threshold = a.threshold or THRESHOLD[a.text]
    a.out.mkdir(parents=True, exist_ok=True)
    proc = Sam3Processor(M.build(ckpt=a.ckpt).eval(), confidence_threshold=a.threshold)
    for scan in a.scan:
        vs = labelled_sections(a.sections_from, scan) if a.sections_from else list(range(scans.load_vol(scan).shape[1]))
        with torch.no_grad(), torch.autocast("cuda", dtype=torch.bfloat16):
            mask = predict_vol(proc, scans.load_vol(scan), a.text, vs)
        np.savez_compressed(a.out / f"{scan}.npz", V=np.array(vs), mask=mask)
        (a.out / f"{scan}.json").write_text(json.dumps({"grid_id": scans.grid_id(scan), "axes": "V, W, U", "ckpt": str(a.ckpt),
                                                        "text": a.text, "threshold": a.threshold}, indent=1))
        print(scan, len(vs), "sections,", int((~mask.any((1, 2))).sum()), "empty", flush=True)


if __name__ == "__main__":
    main()
