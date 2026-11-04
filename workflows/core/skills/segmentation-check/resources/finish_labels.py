"""Finish a labels volume: clear specks, check the result, and write it only when no flag is open.

The last step before a labels volume is reported, so the checks are the checks of the file that is published. It clears each
label's specks (26-connected pieces under `--min-piece-mm3`, the loose fragments a clipped SAM label leaves, which show as dots
off the bone in 3D), then runs `label_stats.py`'s and `unlabelled.py --ranges`'s checks on the cleaned volume. Each flag has a
key (volume:5, pieces:6, absent:3, joined:9-2, joined:1-2, fused:4, ...). A flag is open until the labels no longer raise it
or you pass `--accept <key>=<why>`: the To check item's title that holds it (the CT cannot settle it), or the reason it is
not a fault (a structure the scan's notes put outside the field). A `joined:` or `fused:` flag is never accepted, nor a
`pieces:` flag on a label the anatomy marks `one_piece` (a long bone or the patella is one bone). Two bones that
touch are separated: redo the track first; where they still touch, cut them apart with `classic_segment.py --within A,B` and pass
its output with `--cut`. A `joined:A-B` flag then passes as a cut when every voxel where A and B touch lies on that cut (within
2 voxels: later edits elsewhere are fine) and no more than the contact tolerance of their contact runs through bone no label
holds; the record lists it under `cuts` with where it is. A join the cut does not account for stays open. Refused too: labels that are `classic_segment.py`'s default-mode watershed, which gives every threshold voxel to some
label, so bones that touch at threshold always join; it is the cross-check, not the labels you report. While any flag is open the labels are not written (and an earlier
run's at <out> are deleted): fix them and run this again. An accepted key the labels no longer raise is refused, so the record says what this volume raises.

Writes: <out>  the cleaned labels (.npy, the grid of --labels), with its sidecar, only when no flag is open
        <out stem>-check.json  the check record, cited as evidence when <out> is reported: specks cleared, the per-label
          table, candidates, contacts, every flag with its key, what was accepted and why, `passed`
        <out stem>-candidates.npy  unlabelled.py's candidate volume of the cleaned labels, with its sidecar (relabel.py --pieces)
Prints: one JSON line {labels (null while a flag is open), check, candidates, dropped, open: {key: sentence}, accepted}
Example: python finish_labels.py --hu hu.npy --labels merged.npy --threshold-hu scan-settings.json --ranges anatomy.json
  --out labels.npy --accept 'absent:12=none in its region (section 2)'
Exits 2 with one sentence on bad input, before writing anything; exits 2 after writing the check record and the candidates
while a flag is open.
"""
import argparse
import json
from pathlib import Path

import numpy as np
import sidecar
from classic_segment import touching
from label_stats import check, load_ranges
from scipy import ndimage as ndi
from unlabelled import DEFAULT_CONTACT_MM2, find

CONN26 = np.ones((3, 3, 3))


def drop_specks(labels, vox, min_piece_mm3):
    """`labels` without each label's pieces under `min_piece_mm3`, and {label id: {specks, voxels, mm3}} cleared."""
    out = labels.copy()
    dropped = {}
    for i, box in enumerate(ndi.find_objects(labels), start=1):
        if box is None:
            continue
        pieces, _ = ndi.label(labels[box] == i, CONN26)
        sizes = np.bincount(pieces.ravel())
        sizes[0] = 0
        speck = (sizes > 0) & (sizes * vox < min_piece_mm3)
        if speck.any():
            out[box][speck[pieces]] = 0
            n = int(sizes[speck].sum())
            dropped[i] = {'specks': int(speck.sum()), 'voxels': n, 'mm3': round(n * vox, 5)}
    return out, dropped


# Never accepted. Two bones that touch are separated (a redone track, else a recorded cut, --cut); a fused: candidate is
# labelled, and its id is a size rank that shifts between passes.
NEVER_ACCEPTED = {
    'joined:': 'separate the two. Redo the track (sam-segmentation, "When a track fails"); where they still touch, cut them '
               'apart (classic_segment.py --within A,B) and pass the cut with --cut',
    'swapped:': 'the two labels are each other\'s bone: swap them (relabel.py --swap A,B)',
    'fused:': 'it is bone no label holds, touching a big bone: give it its label (relabel.py --pieces, segmentation-check '
              'section 1), and its id shifts between passes',
}

# A one_piece label (anatomy.json) in more than one piece holds bone that is not its own.
ONE_PIECE = ('Give each piece away from the main one to the label it belongs to, or drop it (relabel.py --at <its voxel> '
             '--to <id or 0>); fragments spread across the joint mean the track ran onto other bone: redo it')


def on_cut(labels, pair, at, joined, contact_mm2):
    """None when the contact of the pair in `labels` is the recorded cut `at` (z,y,x rows of the lower label's voxels that
    touched the other after the cut), else why not."""
    lo, hi = pair
    boxes = ndi.find_objects(labels)
    if lo > len(boxes) or hi > len(boxes) or boxes[lo - 1] is None or boxes[hi - 1] is None:
        return 'one of the two labels is gone'
    box = tuple(slice(max(0, min(p.start, q.start) - 1), max(p.stop, q.stop) + 1) for p, q in zip(boxes[lo - 1], boxes[hi - 1]))
    now = touching(labels[box], lo, hi)
    near = np.zeros(now.shape, bool)
    rel = at - [s.start for s in box]
    keep = np.all((rel >= 0) & (rel < now.shape), axis=1)
    near[tuple(rel[keep].T)] = True
    near = ndi.binary_dilation(near, structure=np.ones((3, 3, 3), bool), iterations=2)
    off = int((now & ~near).sum())
    if off:
        z, y, x = np.argwhere(now & ~near)[0] + [s.start for s in box]
        return f'{off} voxels of their contact lie off the cut, e.g. at {[int(z), int(y), int(x)]}; cut again from these labels'
    if joined['mm2'] - joined['direct_mm2'] > contact_mm2:
        return (f'{round(joined["mm2"] - joined["direct_mm2"], 5)} mm2 of the contact runs through bone no label holds that the cut '
                'did not take (a piece over --bridge-max-mm3, or one touching a third bone: see the fused flags and candidates): '
                'label it (relabel.py --pieces), then cut again from these labels')
    return None


def accepted_arg(s):
    key, sep, why = s.partition('=')
    if not sep or not key.strip() or not why.strip():
        raise argparse.ArgumentTypeError(f'{s!r} is not <key>=<why>, e.g. "absent:12=none in its region"')
    for prefix, fix in NEVER_ACCEPTED.items():
        if key.strip().startswith(prefix):
            raise argparse.ArgumentTypeError(f'{key.strip()} cannot be accepted: {fix}')
    return key.strip(), why.strip()


if __name__ == '__main__':
    ap = sidecar.parser(__doc__)
    ap.add_argument('--hu', type=sidecar.existing, required=True, help='hu.npy of the scan')
    ap.add_argument('--labels', type=sidecar.existing, required=True, help='labels .npy on the scan grid to finish, with its sidecar beside it')
    ap.add_argument('--threshold-hu', type=sidecar.threshold_arg, required=True, help='the scan\'s segmentation threshold: its scan-settings.json, or a number in HU')
    ap.add_argument('--ranges', type=sidecar.existing, required=True, help='the anatomy reference\'s anatomy.json')
    ap.add_argument('--out', required=True, help='labels .npy to write: the file you report')
    ap.add_argument('--accept', type=accepted_arg, action='append', default=[], metavar='KEY=WHY',
                    help='a flag that stays, by key, and why: the To check item that holds it, or why it is not a fault (repeatable)')
    ap.add_argument('--cut', type=sidecar.existing, action='append', default=[], metavar='CUT.npy',
                    help='a classic_segment.py --within A,B output whose recorded cut lets the A-B contact pass (repeatable)')
    ap.add_argument('--min-piece-mm3', type=float, default=0.01, help='mm3: pieces of a label smaller than this are specks, cleared')
    ap.add_argument('--contact-mm2', type=float, default=DEFAULT_CONTACT_MM2,
                    help='mm2: unlabelled.py\'s contact tolerance; it can be lowered, not raised')
    a = ap.parse_args()
    out = Path(a.out)
    if out.suffix != '.npy':
        sidecar.fail(f'--out {a.out} must be a .npy path')
    if out.resolve() == Path(a.labels).resolve():
        sidecar.fail(f'--out is --labels ({a.labels}): write the finished labels to a new path')
    if a.contact_mm2 > DEFAULT_CONTACT_MM2:
        sidecar.fail(f'--contact-mm2 {a.contact_mm2} is above the tolerance {DEFAULT_CONTACT_MM2}: a join is separated, not measured looser')
    if not sidecar.sidecar_path(a.labels).exists():
        sidecar.fail(f'{a.labels} has no sidecar beside it: finish the labels a workflow script wrote')
    made = json.loads(sidecar.sidecar_path(a.labels).read_text())
    # a nudge, not a guarantee: any later script rewrites the sidecar; the joined flags are the gate
    if made.get('script') == 'classic_segment.py' and made.get('params', {}).get('within') is None:
        sidecar.fail(f'{a.labels} is classic_segment.py\'s watershed, the cross-check: it gives every threshold voxel to a label, '
                     'so touching bones always join. Finish the labels you made (the merged SAM labels and your fixes) instead')
    cut_files = {}
    for c in a.cut:
        if not sidecar.sidecar_path(c).exists():
            sidecar.fail(f'--cut {c} has no sidecar beside it')
        meta = json.loads(sidecar.sidecar_path(c).read_text())
        pair = meta.get('params', {}).get('within')
        npz = Path(c).with_name(f'{Path(c).stem}-cuts.npz')
        if meta.get('script') != 'classic_segment.py' or not isinstance(pair, list) or len(pair) != 2 or not npz.exists():
            sidecar.fail(f'--cut {c} is not a classic_segment.py --within A,B output with its -cuts.npz beside it')
        lo, hi = sorted(pair)
        cut_files[(lo, hi)] = (c, np.load(npz)[f'{lo}-{hi}'], meta['params'].get('moved_mm3'))
    accepted = dict(a.accept)
    labels = np.load(a.labels)
    sp = sidecar.grid(str(sidecar.sidecar_path(a.labels)))['spacing_zyx_mm']
    expected = load_ranges(a.ranges)
    whole = {f'pieces:{i}' for i, e in expected.items() if e.get('one_piece')}
    for key in sorted(set(accepted) & whole):
        sidecar.fail(f'{key} cannot be accepted: {expected[int(key[7:])]["name"]} is one bone. {ONE_PIECE}')
    cleaned, dropped = drop_specks(labels, float(np.prod(sp)), a.min_piece_mm3)
    del labels
    table, flags, _ = check(cleaned, sp, expected, min_piece_mm3=a.min_piece_mm3)
    cand_path = out.with_name(f'{out.stem}-candidates.npy')
    cands, report = find(a.hu, cleaned, sp, a.threshold_hu, expected, str(cand_path), a.min_piece_mm3, contact_mm2=a.contact_mm2)
    sidecar.write(str(cand_path), like=str(sidecar.sidecar_path(a.labels)), inputs=[a.hu, a.labels],
                  params={'threshold_hu': a.threshold_hu, 'min_mm3': a.min_piece_mm3, 'contact_mm2': a.contact_mm2})
    flags.update(report['flags'])
    cuts = {}
    for j in report['joined']:
        key = f'joined:{j["label"]}-{j["bone"]}'
        pair = tuple(sorted((j['label'], j['bone'])))
        if key not in flags or pair not in cut_files:
            continue
        path, at, moved = cut_files[pair]
        why = on_cut(cleaned, pair, at, j, a.contact_mm2)
        if why is None:
            cuts[key] = {'cut': path, 'voxels': len(at), 'moved_mm3': moved, 'patch_mm2': j['largest_patch_mm2'], 'voxel_zyx': j['voxel_zyx']}
            del flags[key]
        else:
            flags[key] += f'. The cut in {path} does not account for it: {why}'
    unraised = sorted(set(accepted) - set(flags))
    open_flags = {k: v for k, v in flags.items() if k not in accepted}
    passed = not open_flags and not unraised
    record = {
        'labels': str(out) if passed else None, 'from': a.labels, 'hu': a.hu, 'threshold_hu': a.threshold_hu, 'ranges': a.ranges,
        'min_piece_mm3': a.min_piece_mm3, 'contact_mm2': a.contact_mm2, 'specks_cleared': dropped, 'stats': table,
        'candidates': str(cand_path), 'top_candidates': cands[:12], 'joined': report['joined'], 'fused': report['fused'],
        'flags': flags, 'accepted': {k: accepted[k] for k in sorted(accepted) if k in flags}, 'open': open_flags,
        'accepted_not_raised': unraised, 'cuts': cuts, 'passed': passed}
    check_path = out.with_name(f'{out.stem}-check.json')
    check_path.write_text(json.dumps(record, indent=1) + '\n')
    if not passed:  # an earlier pass's labels would otherwise sit at --out beside a record that refuses them
        out.unlink(missing_ok=True)
        sidecar.sidecar_path(str(out)).unlink(missing_ok=True)
    else:
        np.save(out, cleaned)
        sidecar.write(str(out), like=str(sidecar.sidecar_path(a.labels)), inputs=[a.labels, a.hu],
                      params={'min_piece_mm3': a.min_piece_mm3, 'check': str(check_path)})
    sidecar.emit(labels=str(out) if passed else None, check=str(check_path), candidates=str(cand_path), dropped=dropped,
                 open=open_flags, accepted=record['accepted'], cuts=cuts)
    if unraised:
        sidecar.fail(f'--accept names {unraised}, which these labels do not raise: drop it (a fixed flag needs no reason); labels not written')
    if open_flags:
        fixed_only = [k for k in open_flags if k.startswith(tuple(NEVER_ACCEPTED)) or k in whole]
        rest = [k for k in open_flags if k not in fixed_only]
        said = f'{len(open_flags)} flag(s) open: '
        if fixed_only:
            said += (f'{", ".join(fixed_only)} must be fixed (a joined pair separated, by a redone track or else a --cut; a fused '
                     'candidate labelled' + (f'; a one-piece bone made one piece: {ONE_PIECE[0].lower() + ONE_PIECE[1:]}'
                                             if set(fixed_only) & whole else '') + ')')
        if rest:
            said += ('; ' if fixed_only else '') + (f'{", ".join(rest)}: fix them, or pass --accept <key>=<why> for one the CT '
                                                    'cannot settle (the To check item that holds it)')
        sidecar.fail(said + '; labels not written')
