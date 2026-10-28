"""Where two segmentations disagree: bone voxels the classic method labels that your labels give to another label (or to
nothing), grouped into 3D regions, ranked by size, with a panel for the largest ones.

  python disagree.py --hu hu.npy --labels labels.npy --classic classic.npy --out <outdir> [--frame frame.json]
        [--ids 1,2,3] [--min-mm3 0.005] [--render 6] [--names 1=femur,2=tibia]

Writes <outdir>/disagreement.npy (uint16 region id by rank, 1 = largest; regions under the floor are not numbered) with its
sidecar, <outdir>/regions.json, and <outdir>/panel_<id>.jpg for the `--render` largest regions: the CT alone on the left;
on the right, your outline dashed, the classic outline solid, disagreeing voxels filled amber. `--ids` limits which classic
labels count (e.g. the big bones). The panels cut the scan grid along axis 0 through the region's centre, or the oriented
keyframe direction with `--frame`. Register each region you cannot settle as a labels volume output so a To check item can
point at it (`focus.volumeId`, `focus.label` = the region id).
"""
import argparse
import json
import sys
from pathlib import Path

import numpy as np
from scipy import ndimage as ndi

HERE = Path(__file__).resolve().parent
# `python -I` puts no script directory on sys.path, so every directory a script imports from is added here.
sys.path[:0] = [str(HERE), str(HERE.parents[1] / 'microct-core/resources'), str(HERE.parents[1] / 'visual-check/resources')]
try:
    import viewlib as vl
except ModuleNotFoundError as e:
    sys.exit(f'{e}: this script expects <workflows>/microct-analysis/skills/<skill>/resources/ with '
             '<workflows>/microct-analysis/skills/microct-core/resources/sidecar.py beside it')


sidecar = vl.sidecar


def flagged(labels, classic, ids, bone_hu_mask):
    c = np.asarray(classic)
    f = (c > 0) & (np.asarray(labels) != c) & bone_hu_mask
    if ids:
        f &= np.isin(c, ids)
    return f


def region_panel(hu, labels, classic, region_mask, centre, frame, window, path, pad=60):
    """CT, then CT with both outlines and the disagreeing pixels, around `centre` (z,y,x)."""
    import matplotlib.colors
    if frame:
        R = np.array(frame['R'])
        s, r, c = (R @ (np.array(centre) - np.array(frame['origin_zyx']))).round().astype(int)
        cut = lambda v, order: vl.frame_cut(v, frame, 0, int(np.clip(s, 0, frame['shape_srs'][0] - 1)), order=order)
        rc = (int(r), int(c))
    else:
        cut = lambda v, order: np.asarray(v[centre[0]])
        rc = (centre[1], centre[2])
    img, lab, cla = cut(hu, 1), cut(labels, 0).astype(int), cut(classic, 0).astype(int)
    dis = cut(region_mask.astype(np.uint8), 0) > 0
    r0, c0 = max(0, rc[0] - pad), max(0, rc[1] - pad)
    sl = (slice(r0, rc[0] + pad), slice(c0, rc[1] + pad))
    img, lab, cla, dis = img[sl], lab[sl], cla[sl], dis[sl]
    h, w = img.shape
    fig = vl.fig_for(2 * w * 4, h * 4)
    axs = [fig.add_axes([0, 0, 0.5, 1]), fig.add_axes([0.5, 0, 0.5, 1])]
    for ax in axs:
        vl.show_slice(ax, img, window, grid=False)
    ax = axs[1]
    ax.imshow(np.ma.masked_where(~dis, dis), cmap=matplotlib.colors.ListedColormap(['#ffb000']), alpha=0.75,
              interpolation='nearest')
    for lv in np.unique(np.concatenate([lab[lab > 0], cla[cla > 0]])):
        col = vl.colour(lv)
        if (cla == lv).any():
            ax.contour((cla == lv).astype(float), levels=[0.5], colors=[col], linewidths=1.4)
        if (lab == lv).any():
            ax.contour((lab == lv).astype(float), levels=[0.5], colors=[col], linewidths=1.4, linestyles='dashed')
    axs[0].text(2, 10, 'CT', color='w', fontsize=9)
    axs[1].text(2, 10, 'solid = classic, dashed = yours, amber = disagree', color='w', fontsize=8)
    sidecar.save_image(fig, path)


if __name__ == '__main__':
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--hu', required=True)
    ap.add_argument('--labels', required=True)
    ap.add_argument('--classic', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--frame')
    ap.add_argument('--threshold-hu', type=float, required=True, help='bone threshold: only voxels at or above it can disagree')
    ap.add_argument('--ids', help='classic labels that count, e.g. 1,2,3')
    ap.add_argument('--min-mm3', type=float, default=0.005)
    ap.add_argument('--render', type=int, default=6)
    ap.add_argument('--window')
    a = ap.parse_args()
    hu = np.load(a.hu, mmap_mode='r')
    labels = np.load(a.labels, mmap_mode='r')
    classic = np.load(a.classic, mmap_mode='r')
    if not (hu.shape == labels.shape == classic.shape):
        sidecar.fail('hu, labels and classic must be on the same grid: map them to the scan first')
    sp = sidecar.grid(str(sidecar.sidecar_path(a.labels)))['spacing_zyx_mm']
    vox = float(np.prod(sp))
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    ids = [int(i) for i in a.ids.split(',')] if a.ids else None
    f = flagged(labels, classic, ids, np.asarray(hu) >= a.threshold_hu)
    classic_bone = int(np.isin(np.asarray(classic), ids).sum() if ids else (np.asarray(classic) > 0).sum())
    pieces, n = ndi.label(f, np.ones((3, 3, 3)))
    sizes = np.bincount(pieces.ravel())
    sizes[0] = 0
    keep = [int(i) for i in np.argsort(-sizes) if sizes[i] > 0 and sizes[i] * vox >= a.min_mm3]
    objs = ndi.find_objects(pieces)
    reg = np.zeros(hu.shape, np.uint16)
    regions = []
    for rank, i in enumerate(keep, 1):
        sl = objs[i - 1]
        m = pieces[sl] == i
        reg[sl][m] = rank
        pts = np.argwhere(m) + [s.start for s in sl]
        yours = {int(k): int(v) for k, v in zip(*np.unique(np.asarray(labels[sl])[m], return_counts=True))}
        theirs = {int(k): int(v) for k, v in zip(*np.unique(np.asarray(classic[sl])[m], return_counts=True))}
        regions.append({'id': rank, 'voxels': int(sizes[i]), 'volume_mm3': round(float(sizes[i]) * vox, 4),
                            'centre_zyx': pts.mean(0).round().astype(int).tolist(),
                            'bbox_zyx': [[int(s.start), int(s.stop)] for s in sl], 'your_labels': yours, 'classic_labels': theirs})
    np.save(out / 'disagreement.npy', reg)
    sidecar.write(out / 'disagreement.npy', like=str(sidecar.sidecar_path(a.labels)),
                  inputs=[a.hu, a.labels, a.classic], params={'ids': ids, 'min_mm3': a.min_mm3})
    (out / 'regions.json').write_text(json.dumps(regions, indent=1) + '\n')
    frame = vl.load_frame(a.frame) if a.frame else None
    window = vl.parse_window(a.window) if a.window else vl.auto_window(np.asarray(hu[hu.shape[0] // 2]))
    panels = []
    for rg in regions[:a.render]:
        p = out / f'panel_{rg["id"]}.jpg'
        region_panel(hu, labels, classic, reg == rg['id'], rg['centre_zyx'], frame, window, p)
        panels.append(str(p))
    sidecar.emit(regions=str(out / 'regions.json'), disagreement=str(out / 'disagreement.npy'), panels=panels,
                 flagged_voxels=int(f.sum()), flagged_pct_of_classic_bone=round(100 * float(f.sum()) / max(classic_bone, 1), 2),
                 regions_over_floor=len(regions), regions_total=int(n),
                 top=[{k: r[k] for k in ('id', 'volume_mm3', 'centre_zyx', 'your_labels', 'classic_labels')} for r in regions[:8]])
