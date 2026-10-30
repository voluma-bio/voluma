"""Every resource script parses its flags with `sidecar.parser`. argparse reads `--window -500,6000` as a flag followed by a
flag, and a wrong or refused window costs a whole run, so the parser must take a negative value as the value."""

import sidecar


def make():
    ap = sidecar.parser('doc')
    ap.add_argument('--window')
    ap.add_argument('--point')
    ap.add_argument('--flag', action='store_true')
    ap.add_argument('--many', nargs='+')
    ap.add_argument('--tag', action='append')
    return ap


def test_negative_values_join_their_option():
    a = make().parse_args(['--window', '-500,6000', '--point', '-3', '--tag', '-1', '--tag', 'x'])
    assert (a.window, a.point, a.tag) == ('-500,6000', '-3', ['-1', 'x'])


def test_other_shapes_are_left_alone():
    a = make().parse_args(['--window=-5,9', '--flag', '--many', 'a', 'b'])
    assert (a.window, a.flag, a.many) == ('-5,9', True, ['a', 'b'])
