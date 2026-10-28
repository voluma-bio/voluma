"""Shared drawing helpers for the visual-check renderers: label colours, windowing, pixel-grid figures, cuts through a frame.

Coordinates on every image the agent reads: x is the column (labelled along the top), y is the row (labelled down the
left side), both in pixels of the slice. A box is [row0, col0, row1, col1] = [y0, x0, y1, x1], ends inclusive.
"""
import json
import sys
from pathlib import Path

import matplotlib
import numpy as np
from scipy import ndimage as ndi

matplotlib.use('Agg')
import matplotlib.pyplot as plt

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'microct-core/resources'))
import sidecar

PALETTE = ['#ff3b30', '#34c759', '#0a84ff', '#ffcc00', '#bf5af2', '#ff9f0a', '#64d2ff', '#ff6482',
           '#30d158', '#ac8e68', '#5e5ce6', '#ffd60a']
GRID_COLOR = '#00e5ff'


def colour(label):
    return PALETTE[(int(label) - 1) % len(PALETTE)]


def parse_window(s):
    lo, hi = (float(x) for x in s.split(','))
    return lo, hi


def auto_window(img):
    """Bone-oriented window when the caller gave none: 1st percentile of the bright half to the 99.9th of all."""
    v = np.asarray(img).ravel()[::97]
    return float(np.percentile(v, 50)), float(np.percentile(v, 99.9))


def parse_names(s):
    """'1=femur,2=tibia' -> {1: 'femur', 2: 'tibia'}"""
    return {} if not s else {int(k): v for k, v in (p.split('=', 1) for p in s.split(','))}


def fig_for(w_px, h_px, max_px=sidecar.MAX_IMAGE_PX, dpi=100):
    """A figure whose pixel size is the slice's, scaled down to fit max_px on its longer side."""
    scale = min(1.0, max_px / max(w_px, h_px))
    return plt.figure(figsize=(w_px * scale / dpi, h_px * scale / dpi), dpi=dpi, facecolor='black')


def show_slice(ax, img, window, grid=True, step=100, title=None):
    h, w = img.shape
    ax.imshow(img, cmap='gray', vmin=window[0], vmax=window[1], interpolation='nearest')
    if grid:
        for v in range(0, w, step):
            ax.axvline(v, color=GRID_COLOR, lw=0.4, alpha=0.6)
            ax.text(v + 2, 12, str(v), color=GRID_COLOR, fontsize=8)
        for v in range(0, h, step):
            ax.axhline(v, color=GRID_COLOR, lw=0.4, alpha=0.6)
            ax.text(2, v - 3, str(v), color=GRID_COLOR, fontsize=8)
    if title:
        ax.text(w / 2, h - 10, title, color='w', ha='center', fontsize=9)
    ax.set_axis_off()


def draw_labels(ax, lab, alpha=0.18):
    """Tint plus outline for every label present in the 2D array `lab`."""
    for lv in np.unique(lab[lab > 0]):
        m = lab == lv
        c = colour(lv)
        ax.contour(m.astype(float), levels=[0.5], colors=[c], linewidths=1.2)
        ax.imshow(np.ma.masked_where(~m, m), cmap=matplotlib.colors.ListedColormap([c]), alpha=alpha,
                  interpolation='nearest')


def draw_box(ax, box, name=None, color='#ff9f0a'):
    r0, c0, r1, c1 = box
    ax.add_patch(plt.Rectangle((c0, r0), c1 - c0, r1 - r0, fill=False, ec=color, lw=1.5))
    if name:
        ax.text(c0 + 3, r0 + 14, name, color=color, fontsize=9)


def draw_point(ax, rc, name=None, color='#ff9f0a'):
    ax.plot([rc[1]], [rc[0]], marker='+', color=color, ms=14, mew=2)
    if name:
        ax.text(rc[1] + 8, rc[0] - 6, name, color=color, fontsize=9)


def load_frame(path):
    return json.loads(Path(path).read_text())


def frame_cut(vol, frame, axis, index, order=1, cval=0):
    """One plane of the oriented stack, sampled straight from the scan-grid volume `vol` (Z,Y,X).

    axis 0 = slice `index` (rows x columns), axis 1 = row `index` (slices x columns), axis 2 = column `index`
    (slices x rows). order 0 for labels, 1 for HU.
    """
    R = np.array(frame['R'])
    o = np.array(frame['origin_zyx'])
    S, H, W = frame['shape_srs']
    if axis == 0:
        a, b = np.mgrid[0:H, 0:W].astype(np.float32)
        s, r, c = np.full_like(a, index), a, b
    elif axis == 1:
        a, b = np.mgrid[0:S, 0:W].astype(np.float32)
        s, r, c = a, np.full_like(a, index), b
    else:
        a, b = np.mgrid[0:S, 0:H].astype(np.float32)
        s, r, c = a, b, np.full_like(a, index)
    coords = o[:, None, None] + s * R[0][:, None, None] + r * R[1][:, None, None] + c * R[2][:, None, None]
    return ndi.map_coordinates(vol, coords, order=order, mode='constant', cval=cval)
