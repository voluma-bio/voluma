"""A second opinion on boundaries: a seeded watershed inside the bone threshold, seeded from the labels you already have.

  python classic_segment.py --hu hu.npy --labels labels.npy --out classic.npy --threshold-hu 2500 [--core-mm 0.05]
  python classic_segment.py --hu hu.npy --labels labels.npy --out split.npy --threshold-hu 2500 --within 2 --seeds seeds.json

Default mode: seeds are the eroded cores of each label (`--core-mm` deep; a label with no core left seeds from its bone voxels),
the elevation is the Gaussian gradient magnitude of the HU volume (sigma 1 voxel), and basins grow with 6-connectivity inside
bone. It shares the labels' idea of which bone is which, so it checks where boundaries run, not identity: a label on two bones
stays on two bones.

`--within L --seeds seeds.json` splits the voxels of label L between parts you seed: seeds.json is
{"<label>": [[z,y,x], ...]}, one entry per part (use L for the part that keeps its id). Each seed grows to a ball of 3 voxels
before the watershed; voxels of other labels are left alone. The elevation here is minus the distance to the label's edge,
so the cut falls where the label pinches (the contact), whatever the HU gradient does; a seed only has to lie inside its part.
"""
import argparse
import json
import sys
from pathlib import Path

import numpy as np
from scipy import ndimage as ndi
from skimage.segmentation import watershed

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'microct-core/resources'))
import sidecar

MARGIN = 10


def crop_box(mask, margin=MARGIN):
    sl = ndi.find_objects(mask.astype(np.uint8))[0]
    return tuple(slice(max(0, s.start - margin), s.stop + margin) for s in sl)


def cores(lab, core_vox, bone):
    seeds = np.zeros(lab.shape, np.int32)
    n_fallback = []
    for lv in (int(i) for i in np.unique(lab) if i > 0):
        m = lab == lv
        core = ndi.binary_erosion(m, iterations=core_vox)
        if not core.any():
            core = m & bone
            n_fallback.append(lv)
        seeds[core] = lv
    return seeds, n_fallback


def grow(elevation, seeds, mask):
    return watershed(elevation, markers=seeds, mask=mask, connectivity=1).astype(np.uint8)


if __name__ == '__main__':
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--hu', required=True)
    ap.add_argument('--labels', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--threshold-hu', type=float, required=True)
    ap.add_argument('--core-mm', type=float, default=0.05)
    ap.add_argument('--within', type=int)
    ap.add_argument('--seeds')
    a = ap.parse_args()
    hu = np.load(a.hu, mmap_mode='r')
    labels = np.load(a.labels, mmap_mode='r')
    if hu.shape != labels.shape:
        sidecar.fail(f'hu {hu.shape} and labels {labels.shape} are on different grids: map the labels to the scan first')
    sp = sidecar.grid(str(sidecar.sidecar_path(a.labels)))['spacing_zyx_mm']
    if (a.within is None) != (a.seeds is None):
        sidecar.fail('--within and --seeds go together')
    box = crop_box(np.asarray(labels) == a.within if a.within else np.asarray(labels) > 0)
    h = np.asarray(hu[box])
    lab = np.asarray(labels[box])
    bone = h >= a.threshold_hu
    out = np.zeros(hu.shape, np.uint8)
    info = {}
    if a.within is None:
        seeds, info['core_fallback_labels'] = cores(lab, max(1, round(a.core_mm / sp[0])), bone)
        out[box] = grow(ndi.gaussian_gradient_magnitude(h.astype(np.float32), sigma=1.0), seeds, bone)
    else:
        spec = json.loads(Path(a.seeds).read_text())
        seeds = np.zeros(lab.shape, np.int32)
        for k, pts in spec.items():
            for p in pts:
                q = [c - s.start for c, s in zip(p, box)]
                if not all(0 <= c < n for c, n in zip(q, lab.shape)):
                    sidecar.fail(f'seed {p} for part {k} is outside the region around label {a.within}')
                seeds[tuple(q)] = int(k)
        seeds = np.where(ndi.binary_dilation(seeds > 0, iterations=3),
                         ndi.maximum_filter(seeds, size=7), 0) * (lab == a.within)
        inside = (lab == a.within) & bone
        out[box] = np.where(inside, grow(-ndi.distance_transform_edt(inside), seeds, inside), 0)
        merged = np.asarray(labels).copy()
        merged[out > 0] = out[out > 0]
        out = merged
    np.save(a.out, out)
    sidecar.write(a.out, like=str(sidecar.sidecar_path(a.labels)), inputs=[a.hu, a.labels] + ([a.seeds] if a.seeds else []),
                  params={'threshold_hu': a.threshold_hu, 'core_mm': a.core_mm, 'within': a.within})
    vox = float(np.prod(sp))
    ids, counts = np.unique(out[out > 0], return_counts=True)
    sidecar.emit(labels=a.out, volume_mm3={int(i): round(float(c) * vox, 4) for i, c in zip(ids, counts)}, **info)
