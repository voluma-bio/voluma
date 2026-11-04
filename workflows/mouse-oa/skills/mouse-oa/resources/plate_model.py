"""Propose the growth plate's two faces with the fine-tuned plate model: what the `segment_plate` tool runs.

The model (`training/plate-finetune`, served on Modal as `plate-serve`) is SAM 3.1 fine-tuned to find the plate as a band on a
coronal section of the tibia grid. Three checkpoints each draw the band; each band's faces are its first and last row W in every
column, on the run of band nearest the cut line. This script sends every `section_step_um`-th coronal section of tibia-hu.npy and
tibia-mask.npy to the model through the run's gateway (the sandbox holds a gateway token, never the model's key), and turns the
three checkpoints' faces into one proposal: in each column, the median of the checkpoints that found a face there, kept where at
least `min_checkpoints` did and they agree within `flag_spread_um` on both faces. Like `plate_faces.py`'s, this is a proposal,
never a trace: you look at it section by section, keep what sits on the plate and retrace the rest.

Where it finds the plate. A section's span is its first to last kept column; a section with fewer than `min_run_um` of kept
columns has no span and gets nothing. Inside a span every column that is not kept is flagged: no points there, you trace it. A flagged run narrower than
`flag_min_um` gets no points but is not listed (the curves bridge it well inside `max_gap_um`). Outside a span the proposal says
nothing: a span is where you can start, not where you stop, and the faces must still cover the tibia at plate level. A face point
more than `off_tibia_margin_um` off the tibia mask is flagged too, because iioc.py refuses it.

`plate-annotations.json` is in the annotations schema, as `plate_faces.py` writes it: "grid_id", `growth_plate_curves` (annotation A,
for iioc.py) and `growth_plate_distal_curves` (annotation C, for metaphysis_roi.py), one curve per proposed section, a point every
`point_step_um`, none in a flagged column. `plate-faces.json` has the flagged stretches (`stretches`: {"<V>": [{"u": [first U, last U],
"why": [...]}]}) and the coverage (`covered`: the V range and each section's U span), in `plate_faces.py`'s form.

The band. `plate-band.npz` holds the checkpoints' voted band on every section sent, as pieces: each connected piece of band on a
section has its own label. `plate-faces.json` lists them (`pieces`): voxels, U and W extent, face columns kept on it, whether it is the
section's main piece (the one carrying the most face columns), its distance to the main piece, the share of its voxels the checkpoints
disagree on, and `bone_share`: null when it lies on the same part of the section's tibia mask as the main piece, else the size of its
part over the main piece's part. A piece is `suspect` when faces were kept on it and it lies on a part under `stray_bone_share` of the
main one: a band on separate bone, such as the fibula's growth plate, that the faces were bridged onto. Two halves of the plate on
either side of the notch are normal and not suspect. The QC sheet names a section's suspects in its title. `prune_plate.py` drops
pieces or cuts ranges. The band is never clipped to the tibia mask: the mask leaves out much of the plate.

Writes: in <out>, on the aligned grid (array axes W, V, U):
  plate-annotations.json  the proposed curves (annotation A and C), no points in flagged columns
  plate-faces.json        the result record: counts, `stretches`, `covered`, the grid_id and the model's recipe and timings
  plate-model.npz         the model's reply as it came: V, each checkpoint's band mask and faces, the vote, meta
  plate-band.npz          `V` (the sections sent) and `labels` (n, W, U) uint16: the voted band, one label per piece (0: no band)
  qc-plate-<n>.jpg        coronal sections framed on each section's span, every proposed section unless --sections names others:
                          orange proximal face, cyan distal face; a red tick under each flagged column
Prints: the result record {out, values, annotations, model, band, stretches, covered, suspects (the suspect pieces), qc}
Example: python plate_model.py --window <window> --hu-aligned tibia-hu.npy --mask tibia-mask.npy --out plate/
Exits 2 with one sentence, before writing anything, on bad input, when the model cannot be reached or refuses, and when it finds
the plate on fewer than two sections. Then run plate_faces.py instead.
Needs VOLUMA_GATEWAY_URL and VOLUMA_GATEWAY_TOKEN, which a sandbox that holds `segment_plate` has.
"""

import io
import json
import os
import time
import urllib.error
import urllib.request
from pathlib import Path

import numpy as np
import sidecar
import viewlib as vl
from annotations import load_annotations
from plate_faces import curves, runs_of
from scipy import ndimage as ndi

HERE = Path(__file__).resolve().parent
SPEC_ID = 'plate-model'  # this script's own numbers
SPEC_KEYS = ('min_checkpoints', 'flag_spread_um', 'flag_min_um', 'stray_bone_share')
SHARED_ID = 'plate-faces'  # how a proposal samples the plate and what iioc.py accepts, shared with plate_faces.py
SHARED_KEYS = ('section_step_um', 'point_step_um', 'off_tibia_margin_um', 'min_run_um', 'qc_panels')
RETRY_STATUS = {502, 503, 504}  # the gateway or Modal restarting: one more try after RETRY_WAIT_S, while the deadline allows
RETRY_WAIT_S = 20
DEADLINE_S = 600  # the whole call, retry included, under the tool's 12 minutes; a call is about 1 min, +25 s when no container is up
MODEL_UM = 10.5  # the voxel size the model was trained and is served on (serve.py, meta.um_per_voxel)


def call_model(hu, mask, vs):
    """POST the sections `vs` of the grid to the model through the gateway -> the reply's .npz bytes. One retry on a gateway
    or Modal restart; any other failure exits 2 with what came back."""
    url, token = os.environ.get('VOLUMA_GATEWAY_URL'), os.environ.get('VOLUMA_GATEWAY_TOKEN')
    if not url or not token:
        sidecar.fail('VOLUMA_GATEWAY_URL and VOLUMA_GATEWAY_TOKEN are not set, so the plate model cannot be reached from here: run plate_faces.py instead')
    buf = io.BytesIO()
    np.savez_compressed(buf, hu=np.ascontiguousarray(hu[:, vs, :], np.float32), mask=np.ascontiguousarray(mask[:, vs, :]))
    body = buf.getvalue()
    end = time.monotonic() + DEADLINE_S
    for attempt in (1, 2):
        req = urllib.request.Request(f'{url.rstrip("/")}/plate/', data=body, method='POST',
                                     headers={'authorization': f'Bearer {token}', 'content-type': 'application/octet-stream'})
        try:
            # urllib's timeout is per socket operation; the reply is one read after the model finishes, so it bounds the call
            with urllib.request.urlopen(req, timeout=end - time.monotonic()) as resp:
                return resp.read()
        except urllib.error.HTTPError as e:
            why = f'the plate model answered {e.code}: {e.read(500).decode("utf-8", "replace")}'
            if e.code not in RETRY_STATUS:
                break
        except TimeoutError:
            why = f'the plate model did not answer within {DEADLINE_S} s'
            break  # the GPU work may still be running: a retry would pay for it twice
        except (urllib.error.URLError, ConnectionError) as e:
            why = f'the plate model could not be reached: {getattr(e, "reason", e)}'
        if attempt == 1 and end - time.monotonic() > 2 * RETRY_WAIT_S + 120:
            time.sleep(RETRY_WAIT_S)
        else:
            break
    sidecar.fail(f'{why}; run plate_faces.py instead')


def combine(z, names, vs, tib, sp, vox):
    """The checkpoints' faces (n, U) per checkpoint -> upper, lower (V, U) on the grid, `kept` (V, U) and the flag reasons.
    A checkpoint whose band is empty on a section abstains there, as in the model's vote."""
    n_v, n_u = tib.shape[1], tib.shape[2]
    tops, bots = (np.stack([z[f'{n}.{k}'] for n in names]).astype(np.float32) for k in ('top', 'bottom'))  # (k, n, U)
    voting = np.stack([z[f'{n}.mask'].any((1, 2)) for n in names])  # (k, n): the checkpoint saw a band on the section
    found = ~np.isnan(tops) & ~np.isnan(bots)
    count = found.sum(0)
    need = np.maximum(np.minimum(sp['min_checkpoints'], voting.sum(0)), 1)[:, None]
    with np.errstate(all='ignore'):  # all-NaN columns stay NaN
        upper, lower = np.nanmedian(tops, 0), np.nanmedian(bots, 0)
        spread = np.maximum(np.nanmax(tops, 0) - np.nanmin(tops, 0), np.nanmax(bots, 0) - np.nanmin(bots, 0))
    lower = np.maximum(lower, upper + 1)
    margin = sp['off_tibia_margin_um'] / 1000 / vox
    off = np.zeros_like(found[0])
    for i, v in enumerate(vs):  # a face more than the margin off the tibia mask: iioc.py refuses the point
        dist = ndi.distance_transform_edt(~tib[:, v, :])
        for face in (upper[i], lower[i]):
            ok = ~np.isnan(face)
            w = np.clip(np.rint(face[ok]).astype(int), 0, tib.shape[0] - 1)
            off[i, ok] |= dist[w, np.flatnonzero(ok)] > margin
    why = {
        'the checkpoints disagree on a face': (count >= need) & (spread * vox * 1000 > sp['flag_spread_um']),
        'too few checkpoints found the plate': (count > 0) & (count < need),
        'face off the tibia mask': off,
    }
    kept_n = (count >= need) & ~np.logical_or.reduce(list(why.values()))
    full = lambda a, fill: np.full((n_v, n_u), fill, a.dtype)
    up, lo, kept = full(upper, np.nan), full(lower, np.nan), full(kept_n, False)
    up[vs], lo[vs], kept[vs] = upper, lower, kept_n
    whys = {}
    for k, m in why.items():
        whys[k] = full(m, False)
        whys[k][vs] = m
    return up, lo, kept, whys


def spans_flags(kept, vs, min_cols, min_run):
    """Per section, the span {V: (first, last)} of its kept columns, and `flagged` (V, U): inside a span, not kept, in runs of at
    least `min_run` columns (narrower holes get no points and no flag). A section with fewer than `min_cols` kept columns gets
    no span: on the end sections a partial plate's few columns are where the model is most often wrong."""
    spans, flagged = {}, np.zeros_like(kept)
    for v in vs:
        us = np.flatnonzero(kept[v])
        if len(us) >= max(min_cols, 2):
            spans[int(v)] = (int(us[0]), int(us[-1]))
            for a, b in runs_of(~kept[v, us[0] : us[-1] + 1]):
                if b - a + 1 >= min_run:
                    flagged[v, us[0] + a : us[0] + b + 1] = True
    return spans, flagged


def stretches(flagged, why, sections):
    found = {}
    for v in sections:
        if spans := runs_of(flagged[v]):
            found[str(v)] = [{'u': [int(a), int(b)], 'why': [r for r, m in why.items() if m[v, a : b + 1].any()] or ['no checkpoint found the plate']}
                             for a, b in spans]
    return found


def band_pieces(z, names, vs, tib, upper, lower, kept, vox, stray_share):
    """The voted band as pieces -> labels (n, W, U) uint16 on the sections sent and the piece table. The vote is the model's
    (vote.py, abstain): a voxel is band where at least half the checkpoints that saw a band on the section have it."""
    masks = np.stack([z[f'{n}.mask'] for n in names])  # (k, n, W, U)
    voting = masks.any((2, 3), keepdims=True).sum(0)
    votes = masks.sum(0)
    band = (votes >= np.maximum(voting, 1) / 2) & (votes > 0)
    labels, table, next_id = np.zeros(band.shape, np.uint16), [], 1
    for i, v in enumerate(vs):
        lab, n = ndi.label(band[i], structure=np.ones((3, 3)))
        if not n:
            continue
        cols = np.flatnonzero(kept[v])
        on = np.zeros(n + 1, int)  # face columns per piece: the kept column's upper or lower face row lies on it (within a row)
        for face in (upper[v], lower[v]):
            w = np.rint(face[cols]).astype(int)
            hit = np.zeros(len(cols), int)
            for dw in (0, -1, 1):
                ww = np.clip(w + dw, 0, lab.shape[0] - 1)
                hit = np.where(hit > 0, hit, lab[ww, cols])
            np.add.at(on, hit, 1)
        on[0] = 0
        main = int(on.argmax()) if on.any() else 0
        gap = ndi.distance_transform_edt(lab != main) if main else None
        parts, _ = ndi.label(tib[:, v, :], structure=np.ones((3, 3)))  # the section's tibia mask in parts; each band voxel takes its nearest
        part_size = np.bincount(parts.ravel())
        _, (iw, iu) = ndi.distance_transform_edt(parts == 0, return_indices=True)
        near = parts[iw, iu]
        part_of = [int(np.bincount(near[lab == k]).argmax()) for k in range(n + 1)]
        for k in range(1, n + 1):
            piece = lab == k
            share = None if not main or part_of[k] == part_of[main] else round(part_size[part_of[k]] / part_size[part_of[main]], 3)
            w_idx, u_idx = np.nonzero(piece)
            labels[i][piece] = next_id
            table.append({'id': next_id, 'v': int(v), 'voxels': int(piece.sum()), 'u': [int(u_idx.min()), int(u_idx.max())],
                          'w': [int(w_idx.min()), int(w_idx.max())], 'face_columns': int(on[k]), 'main': k == main,
                          'gap_to_main_um': None if gap is None or k == main else round(float(gap[piece].min()) * vox * 1000, 1),
                          'disagreement': round(float((votes[i][piece] < voting[i, 0, 0]).mean()), 3),
                          'bone_share': share, 'suspect': bool(on[k]) and share is not None and share < stray_share})
            next_id += 1
    return labels, table


def qc_images(out, h, upper, lower, kept, flagged, spans, sections, panels, window, vox, suspects):
    """qc-plate-<n>.jpg: `panels` coronal sections per sheet, framed on each span; faces on the kept columns, a red tick under each
    flagged column (at the section's median face height where the column has none)."""
    paths, x = [], np.arange(h.shape[2])
    for n, chunk in enumerate(np.array_split(sections, -(-len(sections) // panels))):
        crops, curve_sets, titles = [], [], []
        for v in chunk:
            a, b = spans[int(v)]
            show = np.where(kept[v], 1.0, np.nan)
            w0, w1 = int(np.nanmin(upper[v] * show)) - 30, int(np.nanmax(lower[v] * show)) + 30
            crops.append((max(w0, 0), max(a - 20, 0), min(w1, h.shape[0]), min(b + 21, h.shape[2])))
            tick = np.where(np.isnan(lower[v]), np.nanmedian(lower[v] * show), lower[v]) + 6
            curve_sets.append([(x, upper[v] * show, 'orange'), (x, lower[v] * show, 'cyan'), (x[flagged[v]], tick[flagged[v]], 'red', '|')])
            odd = [f"{s['id']} (U {s['u'][0]}-{s['u'][1]})" for s in suspects if s['v'] == v]
            titles.append(f'V={v}, proposed U {a} to {b}' + (f'; suspect piece {", ".join(odd)}' if odd else ''))
        path = out / f'qc-plate-{n + 1}.jpg'
        vl.slice_sheet(path, h, [], 1, [int(v) for v in chunk], window, cols=3, crops=crops, curves=curve_sets, titles=titles,
                       axis_names=('W', 'V', 'U'), voxel_mm=vox)
        paths.append(str(path))
    return paths


def main():
    ap = sidecar.parser(__doc__)
    ap.add_argument('--spec', type=sidecar.existing, default=str(HERE / 'protocol.json'),
                    help=f"the workflow's protocol.json: entries {SPEC_ID} and {SHARED_ID} (default: the one beside this script)")
    ap.add_argument('--window', type=vl.window_arg, metavar='lo,hi', required=True,
                    help='QC display window, as the other QC scripts take it: lo,hi in HU or the file that holds it. Only the QC sheets '
                         'use it; the model gets raw HU and applies its own training window')
    ap.add_argument('--hu-aligned', type=sidecar.existing, required=True, help='tibia-hu.npy from tibia_frame.py')
    ap.add_argument('--mask', type=sidecar.existing, required=True, help='tibia-mask.npy from tibia_frame.py')
    ap.add_argument('--out', required=True, help='output directory (created)')
    ap.add_argument('--sections', metavar='V,V,...', help='V indices of the coronal sections to render (default: every proposed section)')
    a = ap.parse_args()
    sp = {**sidecar.protocol(a.spec, SHARED_ID, *SHARED_KEYS), **sidecar.protocol(a.spec, SPEC_ID, *SPEC_KEYS)}
    side = sidecar.sidecar_path(a.hu_aligned)
    if not side.exists():
        sidecar.fail(f'{side} (the sidecar of tibia-hu.npy, which names its grid) is missing: pass the tibia-hu.npy tibia_frame.py wrote')
    grid = sidecar.grid(side)
    vox = grid['spacing_zyx_mm'][0]
    h = np.asarray(np.load(a.hu_aligned, mmap_mode='r'), np.float32)
    tib = np.load(a.mask).astype(bool)
    if tib.shape != h.shape or list(h.shape) != list(grid['shape']):
        sidecar.fail(f'tibia-hu.npy {h.shape} and tibia-mask.npy {tib.shape} must be one grid: pass the files tibia_frame.py wrote together')
    if abs(vox * 1000 - MODEL_UM) > 0.05:
        sidecar.fail(f'the grid is {vox * 1000:g} um a voxel and the plate model only knows {MODEL_UM:g} um scans: run plate_faces.py instead')
    has = np.flatnonzero(tib.any((0, 2)))
    if len(has) < 2:
        sidecar.fail('the tibia mask is empty on all but one coronal section: check tibia_frame.py\'s mask')
    step_v = max(1, round(sp['section_step_um'] / 1000 / vox))
    vs = sorted(set(range(has[0], has[-1] + 1, step_v)) | {int(has[-1])})
    reply = call_model(h, tib, vs)
    z = np.load(io.BytesIO(reply))
    meta = json.loads(str(z['meta']))
    names = list(meta['ckpt'])
    if [int(v) for v in z['V']] != list(range(len(vs))):
        sidecar.fail(f'the plate model answered sections {list(z["V"])[:5]}..., not the {len(vs)} sent: run plate_faces.py instead')
    upper, lower, kept, why = combine(z, names, vs, tib, sp, vox)
    spans, flagged = spans_flags(kept, vs, round(sp['min_run_um'] / 1000 / vox), max(1, round(sp['flag_min_um'] / 1000 / vox)))
    sections = [v for v in vs if v in spans]
    if len(sections) < 2:
        sidecar.fail('the plate model found the plate on fewer than two sections: that is its verdict on this scan, not a fault. Run '
                     'plate_faces.py instead, and check its proposal hardest: the plate may be hard to see here')
    qc_v = sections
    if a.sections:
        qc_v = [int(x) for x in a.sections.split(',')]
        if bad := [v for v in qc_v if v not in spans]:
            sidecar.fail(f'--sections {bad[0]} has no proposal: name V indices from {sections}')
    step_u = max(1, round(sp['point_step_um'] / 1000 / vox))
    show = np.where(kept, 1.0, np.nan)
    ann = {'grid_id': grid['grid_id'],
           'growth_plate_curves': curves(upper * show, kept, sections, step_u),
           'growth_plate_distal_curves': curves(lower * show, kept, sections, step_u)}
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    ann_path = out / 'plate-annotations.json'
    ann_path.write_text(json.dumps(ann) + '\n')
    load_annotations(ann_path, grid)  # the curves obey the schema every later script reads
    (out / 'plate-model.npz').write_bytes(reply)
    found = stretches(flagged, why, sections)
    cover = {'v': [sections[0], sections[-1]], 'sections': {str(v): {'u': list(spans[v])} for v in sections}}
    labels, pieces = band_pieces(z, names, vs, tib, upper, lower, kept, vox, sp['stray_bone_share'])
    np.savez_compressed(out / 'plate-band.npz', V=np.array(vs), labels=labels)
    suspects = [p for p in pieces if p['suspect']]
    qc = qc_images(out, h, upper, lower, kept, flagged, spans, qc_v, sp['qc_panels'], a.window, vox, suspects)
    in_span = sum(hi - lo + 1 for lo, hi in spans.values())
    values = {
        'plate-flagged-fraction': sidecar.value(
            flagged.sum() / in_span, 'fraction', 'share of the columns inside the proposed spans that are to be traced: no curve points there', kind='diagnostic'),
        'plate-proposed-sections': sidecar.value(
            len(ann['growth_plate_curves']['slices']), 'count', f'coronal sections with a proposed curve, every {sp["section_step_um"]:g} um', kind='diagnostic'),
        'plate-model-sections-sent': sidecar.value(len(vs), 'count', 'coronal sections sent to the plate model', kind='diagnostic'),
    }
    model = {'recipe': meta['ckpt'], 'vote': meta['vote'], 'gpu': meta['gpu'], 'seconds': meta['seconds']['total']}
    sidecar.emit_values(
        out / 'plate-faces.json',
        values,
        {'grid_id': grid['grid_id'], 'source': 'segment_plate', 'plate_model': model, 'stretches': found, 'covered': cover,
         'pieces': pieces},
        annotations=str(ann_path),
        model=str(out / 'plate-model.npz'),
        band=str(out / 'plate-band.npz'),
        stretches=found,
        covered=cover,
        suspects=suspects,
        qc=qc,
    )


if __name__ == '__main__':
    main()
