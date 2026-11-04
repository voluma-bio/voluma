"""Prune the plate model's proposal: drop faces on stray band pieces and cut U ranges, for you to trace.

`segment_plate` (plate_model.py) writes the checkpoints' voted band as pieces (`plate-band.npz`) and lists them in `plate-faces.json`
(`pieces`; `suspect` marks a piece with faces on it that lies on a small separate part of the tibia mask, such as the fibula). Two
operations, which take out points and never add or move one:
  --drop-pieces  removes, on the piece's section, every column where either face lies on the piece (within a row). For a stray that is
                 its own piece: a band on the fibula (the thin bone beside the tibia) or on another bone is a stray, drop it.
  --cut          removes every column in a U range on a section or a V range of sections. For a stray joined to the plate by a bridge
                 of band: it is one piece with the plate, so dropping it would drop the plate too; cut the bridge and the stray.
Both faces lose the same columns, so a pruned stretch has no points in either face, never a line drawn across it: iioc.py and
metaphysis_roi.py refuse a face that leaves bone at plate level untraced, so trace every emptied range that is plate (read it off a
zoomed view), or leave it empty where it is not (the fibula is not). A section left with fewer than two points is removed whole.

Writes: in <out>
  plate-annotations.json  the pruned curves (annotation A and C), the same grid_id; copy both keys into your annotations.json
  prune.json              the result record: each drop and cut as asked, and `emptied`: per V the U ranges left with no points
                          ([first, last] removed U) and the sections removed whole
  qc-prune-<n>.jpg        each section pruned: orange proximal and cyan distal face as kept, red crosses where points were removed
Prints: the result record {out, values, annotations, drops, cuts, emptied, removed_sections, qc}. Report the drops and cuts with the
faces, and say what you traced in each emptied range.
Example: python prune_plate.py --proposal plate/ --hu-aligned tibia-hu.npy --window <window> --drop-pieces 71,74 --cut 151-161:283-299 --out plate-pruned/
Exits 2 with one sentence, before writing anything, on a piece id or range that is not in the proposal.
"""

import json
from pathlib import Path

import numpy as np
import sidecar
import viewlib as vl
from annotations import load_annotations
from plate_faces import runs_of

KEYS = ('growth_plate_curves', 'growth_plate_distal_curves')


def parse_cut(text):
    """`V:U0-U1` or `V0-V1:U0-U1` -> (v0, v1, u0, u1), inclusive."""
    try:
        vs, us = text.split(':')
        v0, v1 = (int(x) for x in (vs.split('-') if '-' in vs else (vs, vs)))
        u0, u1 = (int(x) for x in us.split('-'))
    except ValueError:
        sidecar.fail(f'--cut "{text}" is not V:U0-U1 or V0-V1:U0-U1 (integers)')
    if v0 > v1 or u0 > u1:
        sidecar.fail(f'--cut "{text}" runs backwards: write the lower index first')
    return v0, v1, u0, u1


def main():
    ap = sidecar.parser(__doc__)
    ap.add_argument('--proposal', type=sidecar.existing, required=True,
                    help="segment_plate's out folder: plate-annotations.json, plate-faces.json and plate-band.npz")
    ap.add_argument('--hu-aligned', type=sidecar.existing, required=True, help='tibia-hu.npy the proposal was made on (for the QC)')
    ap.add_argument('--window', type=vl.window_arg, metavar='lo,hi', required=True, help="QC display window: the scan's scan-settings.json (intake's), or lo,hi in HU")
    ap.add_argument('--drop-pieces', metavar='ID,ID,...', default='', help="ids from plate-faces.json's `pieces`")
    ap.add_argument('--cut', metavar='V:U0-U1,...', default='', help='U ranges to empty, on one section (V) or every proposed section in V0-V1')
    ap.add_argument('--out', required=True, help='output directory (created); not the proposal folder')
    a = ap.parse_args()
    src = Path(a.proposal)
    for name in ('plate-annotations.json', 'plate-faces.json', 'plate-band.npz'):
        if not (src / name).exists():
            sidecar.fail(f'{src / name} is missing: pass the folder segment_plate wrote (plate_faces.py writes no band to prune)')
    if Path(a.out).resolve() == src.resolve():
        sidecar.fail('--out is the proposal folder: write the pruned curves to a new folder, so the proposal stays as the model made it')
    side = sidecar.sidecar_path(a.hu_aligned)
    if not side.exists():
        sidecar.fail(f'{side} (the sidecar of tibia-hu.npy) is missing: pass the tibia-hu.npy tibia_frame.py wrote')
    grid = sidecar.grid(side)
    ann = load_annotations(src / 'plate-annotations.json', grid)
    record = json.loads((src / 'plate-faces.json').read_text())
    if record.get('grid_id') != grid['grid_id']:
        sidecar.fail(f'{src / "plate-faces.json"} is for another grid than {a.hu_aligned}: pass the tibia-hu.npy the proposal was made on')
    band = np.load(src / 'plate-band.npz')
    band_v = [int(v) for v in band['V']]
    pieces = {p['id']: p for p in record['pieces']}
    drop_ids = [int(x) for x in a.drop_pieces.split(',') if x.strip()]
    cuts = [parse_cut(x.strip()) for x in a.cut.split(',') if x.strip()]
    if not drop_ids and not cuts:
        sidecar.fail('nothing to prune: name --drop-pieces, --cut or both')
    if bad := [i for i in drop_ids if i not in pieces]:
        sidecar.fail(f'piece {bad[0]} is not in {src / "plate-faces.json"}: name ids from its `pieces`')
    # a worker may have edited the file, so the faces need not share sections or columns: work on their union
    sections = sorted({int(v) for key in KEYS for v in ann[key]['slices']})

    def columns(v):
        """U columns either face has a point on, on section v."""
        return {int(u) for key in KEYS for _, u in ann[key]['slices'].get(str(v), [])}

    for v0, v1, *_ in cuts:
        if not any(v0 <= v <= v1 for v in sections):
            sidecar.fail(f'--cut V {v0}-{v1} holds no proposed section: the proposal has V={sections[0]}..{sections[-1]}, every '
                         f'{sections[1] - sections[0] if len(sections) > 1 else 1} rows')

    # remove[v]: the U columns to take out of both faces on section v
    remove = {v: set() for v in sections}
    drops = []
    for i in drop_ids:
        p = pieces[i]
        v = p['v']
        lab = band['labels'][band_v.index(v)]
        cols = set()
        for key in KEYS:
            for w, u in ann[key]['slices'].get(str(v), []):
                w, u = round(w), int(u)
                if (lab[max(w - 1, 0) : w + 2, u] == i).any():
                    cols.add(u)
        if v in remove:
            remove[v] |= cols
        drops.append({'piece': i, 'v': v, 'u': p['u'], 'columns': len(cols)})
    cut_records = []
    for v0, v1, u0, u1 in cuts:
        n = 0
        for v in sections:
            if v0 <= v <= v1:
                cols = {u for u in columns(v) if u0 <= u <= u1}
                remove[v] |= cols
                n += len(cols)
        cut_records.append({'v': [v0, v1], 'u': [u0, u1], 'columns': n})

    pruned = {'grid_id': ann['grid_id'], **{k: v for k, v in ann.items() if k not in ('grid_id', *KEYS)}}
    emptied, removed_sections, touched = {}, [], []
    for key in KEYS:
        slices = {}
        for k, pts in ann[key]['slices'].items():
            keep = [p for p in pts if p[1] not in remove[int(k)]]
            if len(keep) >= 2:
                slices[k] = keep
        pruned[key] = {**ann[key], 'slices': slices}
    for v in sections:
        if not remove[v]:
            continue
        touched.append(v)
        us = np.array(sorted(columns(v)))
        gone = np.isin(us, sorted(remove[v]))
        emptied[str(v)] = [[int(us[a]), int(us[b])] for a, b in runs_of(gone)]
        if any(str(v) in ann[key]['slices'] and str(v) not in pruned[key]['slices'] for key in KEYS):
            removed_sections.append(v)
            for key in KEYS:
                pruned[key]['slices'].pop(str(v), None)
    if min(len(pruned[key]['slices']) for key in KEYS) < 2:
        sidecar.fail('the pruning leaves fewer than two sections with a curve: that is no proposal; run plate_faces.py or trace the plate yourself')

    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    ann_path = out / 'plate-annotations.json'
    ann_path.write_text(json.dumps(pruned) + '\n')
    load_annotations(ann_path, grid)

    h = np.load(a.hu_aligned, mmap_mode='r')
    qc, x = [], np.arange(h.shape[2])
    panels = sidecar.protocol(Path(__file__).resolve().parent / 'protocol.json', 'plate-faces', 'qc_panels')['qc_panels']
    for n, chunk in enumerate(np.array_split(touched, -(-len(touched) // panels)) if touched else []):
        crops, curve_sets, titles = [], [], []
        for v in chunk:
            v = int(v)
            sets, ws, us = [], [], []
            for key, colour in zip(KEYS, ('orange', 'cyan'), strict=True):
                pts = np.array(ann[key]['slices'].get(str(v), []), float).reshape(-1, 2)
                ws += list(pts[:, 0])
                us += list(pts[:, 1])
                gone = np.isin(pts[:, 1], sorted(remove[v]))
                face = np.full(h.shape[2], np.nan)
                kept = pts[~gone] if str(v) in pruned[key]['slices'] else pts[:0]
                face[kept[:, 1].astype(int)] = kept[:, 0]
                sets.append((x, face, colour, '.'))
                sets.append((pts[gone, 1], pts[gone, 0], 'red', 'x'))
            crops.append((max(int(min(ws)) - 30, 0), max(int(min(us)) - 20, 0), min(int(max(ws)) + 30, h.shape[0]), min(int(max(us)) + 21, h.shape[2])))
            curve_sets.append(sets)
            titles.append(f'V={v}, emptied U ' + ', '.join(f'{p}-{q}' for p, q in emptied[str(v)]) + (' (section removed)' if v in removed_sections else ''))
        path = out / f'qc-prune-{n + 1}.jpg'
        vl.slice_sheet(path, h, [], 1, [int(v) for v in chunk], a.window, cols=3, crops=crops, curves=curve_sets, titles=titles,
                       axis_names=('W', 'V', 'U'), voxel_mm=grid['spacing_zyx_mm'][0])
        qc.append(str(path))

    values = {
        'plate-pruned-columns': sidecar.value(sum(len(c) for c in remove.values()), 'count', 'proposed columns removed from both faces', kind='diagnostic'),
        'plate-pruned-sections': sidecar.value(len(touched), 'count', 'proposed sections with columns removed', kind='diagnostic'),
    }
    sidecar.emit_values(out / 'prune.json', values, {'grid_id': grid['grid_id'], 'proposal': str(src)}, annotations=str(ann_path),
                        drops=drops, cuts=cut_records, emptied=emptied, removed_sections=removed_sections, qc=qc)


if __name__ == '__main__':
    main()
