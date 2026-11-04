"""Finish a labels volume: clear specks, check the result, and write it only when no flag is open.

The last step before a labels volume is reported, so the checks are the checks of the file that is published. It clears each
label's specks (26-connected pieces under `--min-piece-mm3`, the loose fragments a clipped SAM label leaves, which show as dots
off the bone in 3D), then runs `label_stats.py`'s and `unlabelled.py --ranges`'s checks on the cleaned volume. Each flag has a
key (volume:5, pieces:6, absent:3, joined:9-2, joined:1-2, fused:4, ...). A flag is open until the labels no longer raise it
or you pass `--accept <key>=<why>`: the To check item's title that holds it (the CT cannot settle it), or the reason it is
not a fault (a structure the scan's notes put outside the field). A `joined:` or `fused:` flag is never accepted: one label holds
another bone's bone, which the labels can always fix (split it at the contact with `classic_segment.py --within`, or redo the
track). Refused too: labels that are `classic_segment.py`'s default-mode watershed, which gives every threshold voxel to some
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


# a label holding another bone's bone is always fixable, so these flags are fixed, never accepted; fused: ids are also
# candidate size ranks that shift between passes
NEVER_ACCEPTED = ('joined:', 'fused:')


def accepted_arg(s):
    key, sep, why = s.partition('=')
    if not sep or not key.strip() or not why.strip():
        raise argparse.ArgumentTypeError(f'{s!r} is not <key>=<why>, e.g. "absent:12=none in its region"')
    if key.strip().startswith(NEVER_ACCEPTED):
        raise argparse.ArgumentTypeError(f'{key.strip()} cannot be accepted: one label holds another bone\'s bone. Split it at the '
                                         'contact (classic_segment.py --within <label> with seeds from each bone\'s core) or redo '
                                         'the track (sam-segmentation, "When a track fails"), then run this again')
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
    ap.add_argument('--min-piece-mm3', type=float, default=0.01, help='mm3: pieces of a label smaller than this are specks, cleared')
    ap.add_argument('--contact-mm2', type=float, default=DEFAULT_CONTACT_MM2, help='mm2: unlabelled.py\'s contact tolerance')
    a = ap.parse_args()
    out = Path(a.out)
    if out.suffix != '.npy':
        sidecar.fail(f'--out {a.out} must be a .npy path')
    if out.resolve() == Path(a.labels).resolve():
        sidecar.fail(f'--out is --labels ({a.labels}): write the finished labels to a new path')
    made = json.loads(sidecar.sidecar_path(a.labels).read_text())
    if made.get('script') == 'classic_segment.py' and made.get('params', {}).get('within') is None:
        sidecar.fail(f'{a.labels} is classic_segment.py\'s watershed, the cross-check: it gives every threshold voxel to a label, '
                     'so touching bones always join. Finish the labels you made (the merged SAM labels and your fixes) instead')
    accepted = dict(a.accept)
    labels = np.load(a.labels)
    sp = sidecar.grid(str(sidecar.sidecar_path(a.labels)))['spacing_zyx_mm']
    expected = load_ranges(a.ranges)
    cleaned, dropped = drop_specks(labels, float(np.prod(sp)), a.min_piece_mm3)
    del labels
    table, flags, _ = check(cleaned, sp, expected, min_piece_mm3=a.min_piece_mm3)
    cand_path = out.with_name(f'{out.stem}-candidates.npy')
    cands, report = find(a.hu, cleaned, sp, a.threshold_hu, expected, str(cand_path), a.min_piece_mm3, contact_mm2=a.contact_mm2)
    sidecar.write(str(cand_path), like=str(sidecar.sidecar_path(a.labels)), inputs=[a.hu, a.labels],
                  params={'threshold_hu': a.threshold_hu, 'min_mm3': a.min_piece_mm3, 'contact_mm2': a.contact_mm2})
    flags.update(report['flags'])
    unraised = sorted(set(accepted) - set(flags))
    open_flags = {k: v for k, v in flags.items() if k not in accepted}
    passed = not open_flags and not unraised
    record = {
        'labels': str(out) if passed else None, 'from': a.labels, 'hu': a.hu, 'threshold_hu': a.threshold_hu, 'ranges': a.ranges,
        'min_piece_mm3': a.min_piece_mm3, 'contact_mm2': a.contact_mm2, 'specks_cleared': dropped, 'stats': table,
        'candidates': str(cand_path), 'top_candidates': cands[:12], 'joined': report['joined'], 'fused': report['fused'],
        'flags': flags, 'accepted': {k: accepted[k] for k in sorted(accepted) if k in flags}, 'open': open_flags,
        'accepted_not_raised': unraised, 'passed': passed}
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
                 open=open_flags, accepted=record['accepted'])
    if unraised:
        sidecar.fail(f'--accept names {unraised}, which these labels do not raise: drop it (a fixed flag needs no reason); labels not written')
    if open_flags:
        sidecar.fail(f'{len(open_flags)} flag(s) open ({", ".join(open_flags)}): fix the labels and run this again, or pass '
                     '--accept <key>=<why> for one the CT cannot settle (the To check item that holds it); labels not written')
