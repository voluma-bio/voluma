"""Coronal sheets of the growth-plate faces as delivered, for iioc.py and metaphysis_roi.py.

Library, not a script. A face is drawn as the surface the script cut with, not as the proposal: solid between the points the
worker traced, dotted where the surface is held constant past them, over the tibia's outline, on every traced section, so a line
that runs over empty space or up a cortical wall shows. The crop takes in the tibia 80 voxels (0.8 mm) beyond the faces' height range
each way, so a face put in the wrong place does not crop away a plate band within that reach. A band farther away is not shown.
"""

import numpy as np
import viewlib as vl

REACH = 80  # voxels of tibia shown beyond the faces' height range


def delivered_faces(out, h, tib, faces, sections, panels, window, vox):
    """Write `out`/qc-faces-<n>.jpg, `panels` sections per sheet, and return the paths. `faces`: [(label, colour, surface, traced)]:
    the W index per (V, U) the script used, and the bool (V, U) where the worker's points define it. `sections`: the V indices."""
    paths = []
    for n, chunk in enumerate(np.array_split(sorted(sections), -(-len(sections) // panels))):
        crops, curve_sets, titles = [], [], []
        x = np.arange(h.shape[2])
        for v in chunk:
            cols = np.flatnonzero(tib[:, v].any(0) | np.any([t[v] for *_, t in faces], axis=0))
            heights = [s[v, cols] for _, _, s, _ in faces]
            bone = np.flatnonzero(tib[:, v].any(1))
            lo = max(np.nanmin(heights) - REACH, bone[0] - 10)  # the face's range plus 0.8 mm of anatomy each way, within the tibia
            hi = min(np.nanmax(heights) + REACH, bone[-1] + 11)
            crops.append((max(int(lo), 0), max(cols[0] - 10, 0), min(int(hi), h.shape[0]), min(cols[-1] + 11, h.shape[2])))
            curve_sets.append([c for _, colour, s, t in faces for c in
                               ((x, np.where(t[v], s[v], np.nan), colour), (x, np.where(t[v], np.nan, s[v]), colour, ':'))])
            titles.append(f'V={v}: ' + ', '.join(f'{label} {colour}' for label, colour, *_ in faces))
        path = out / f'qc-faces-{n + 1}.jpg'
        vl.slice_sheet(path, h, [(tib, 'yellow')], 1, [int(v) for v in chunk], window, cols=3, crops=crops, curves=curve_sets, titles=titles,
                       axis_names=('W', 'V', 'U'), voxel_mm=vox)
        paths.append(str(path))
    return paths
