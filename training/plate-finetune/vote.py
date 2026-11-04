"""Vote several models' region predictions into one: a voxel is kept when at least half of the voting models have it.

  python vote.py --out preds/band-vote --abstain preds/band-s0-region preds/band-s1-region preds/band-s2-region

Without --abstain every model votes on every section (an empty prediction votes no). With --abstain a model whose prediction is
empty on a section abstains there: the band model fails by returning nothing where the region model fails by being confidently
wrong, so its vote counts only the models that saw something. Inputs: predict.py or band_to_region.py outputs on the same sections.
"""
import argparse
from pathlib import Path

import numpy as np


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("preds", nargs="+", type=Path)
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--abstain", action="store_true", help="a model with an empty section abstains there instead of voting no")
    a = ap.parse_args()
    a.out.mkdir(parents=True, exist_ok=True)
    for f in sorted(a.preds[0].glob("*.npz")):
        zs = [np.load(d / f.name) for d in a.preds]
        assert all(np.array_equal(z["V"], zs[0]["V"]) for z in zs), f"{f.name}: the predictions cover different sections"
        m = np.stack([z["mask"] for z in zs])
        n = m.any((2, 3), keepdims=True).sum(0) if a.abstain else len(zs)   # models voting per section
        votes = m.sum(0)
        np.savez_compressed(a.out / f.name, V=zs[0]["V"], mask=(votes >= np.maximum(n, 1) / 2) & (votes > 0))


if __name__ == "__main__":
    main()
