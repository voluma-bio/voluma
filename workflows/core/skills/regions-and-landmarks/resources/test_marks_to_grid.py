"""A mark's voxels onto a grid: a wrong origin, spacing or axis order puts a researcher's mark thousands of voxels away and
the worker is refused, or (worse) a few voxels away and nothing says so; the same-grid and cross-grid maps are pinned."""

import json
import os
import subprocess
import sys
from pathlib import Path

import frame as fr
import numpy as np

SCRIPT = Path(__file__).with_name('marks_to_grid.py')
UNEVEN = [0.0105, 0.011, 0.012]  # z, y, x: a swapped axis moves the mark
ORIGIN = [7.9, 4.7, 128.9]  # x, y, z mm of scan voxel 0: far from 0, as on OA6-2RK


def headers(tmp, spacing, degrees):
    """hu.json for a scan with `spacing`, and tibia-frame.json turned `degrees` about z (a turned frame needs even spacing)."""
    affine = np.eye(4)
    affine[:3, :3] = np.diag(spacing[::-1])
    affine[:3, 3] = ORIGIN
    scan = {'grid_id': 'scan', 'spacing_zyx_mm': spacing, 'shape_zyx': [400, 400, 400], 'affine_xyz_to_world_mm': affine.tolist()}
    th = np.radians(degrees)
    c, s = np.cos(th), np.sin(th)
    tibia = fr.make('scan', spacing, parent_affine_xyz=affine, R_zyx=[[c, s, 0], [-s, c, 0], [0, 0, 1]], origin_zyx=[30.0, 20.0, 10.0],
                    shape=[362, 344, 340])
    (tmp / 'hu.json').write_text(json.dumps(scan))
    fr.save(tibia, tmp / 'tibia-frame.json')
    return tibia


def voxel_line(zyx):
    """A mark as the delivery prints it: voxels [z, y, x] of the image it was drawn on."""
    return 'drawn on tibia-grid v1, in the XZ plane at voxels ' + '–'.join(f'[{z:.1f}, {y:.1f}, {x:.1f}]' for z, y, x in zyx) + ', length 1.2 mm'


def run(*args):
    env = {**os.environ, 'PYTHONPATH': os.pathsep.join(sys.path)}  # the skills' resources, as the sandbox has them
    out = subprocess.run([sys.executable, str(SCRIPT), *map(str, args)], check=False, capture_output=True, text=True, env=env)
    assert out.returncode == 0, out.stderr
    return json.loads(out.stdout.strip().splitlines()[-1])


def test_a_line_drawn_on_the_tibia_grid_lands_on_its_section(tmp_path):
    headers(tmp_path, UNEVEN, 0)
    zyx = [[202.6, 172, 201.18], [200.93, 172, 226.2], [200.09, 172, 251.21], [202.6, 172, 276.23]]  # run 1f82654f's L1
    f = tmp_path / 'tibia-frame.json'
    got = run('--curve', '--voxels', voxel_line(zyx), '--drawn-on', f, '--grid', f, '--out', tmp_path / 'c.json')
    assert got['section'] == 172 and got['off_section_vox'] < 0.01
    assert got['points'][0] == [202.6, 201.2]


def test_a_mark_drawn_on_the_scan_lands_where_the_frame_puts_those_scan_voxels(tmp_path):
    tibia = headers(tmp_path, [0.0105] * 3, 20)
    frame_zyx = np.array([[200.0, 172, 200], [201, 172, 230], [203, 172, 260]])
    scan_zyx = fr.to_scan_points(frame_zyx, tibia)
    got = run('--curve', '--voxels', voxel_line(scan_zyx), '--drawn-on', tmp_path / 'hu.json',
              '--grid', tmp_path / 'tibia-frame.json', '--out', tmp_path / 'c.json')
    assert got['section'] == 172 and got['off_section_vox'] < 0.1  # the delivery prints voxels to 0.1
    np.testing.assert_allclose(got['points'], frame_zyx[:, [0, 2]], atol=0.1)


def test_seed_on_the_scan_with_an_origin(tmp_path):
    headers(tmp_path, UNEVEN, 0)
    labels = np.zeros((40, 40, 40), np.uint16)
    labels[5:35, 5:35, 5:35] = 1
    np.save(tmp_path / 'labels.npy', labels)
    (tmp_path / 'labels.json').write_text(json.dumps({'grid_id': 'scan', 'spacing_zyx_mm': UNEVEN}))
    ring = [[20, 16, 26], [20, 16, 34], [20, 24, 34], [20, 24, 26]]
    got = run('--seed', '--voxels', voxel_line(ring), '--drawn-on', tmp_path / 'hu.json', '--grid', tmp_path / 'hu.json',
              '--labels', tmp_path / 'labels.npy')
    z, y, x = got['seed_zyx']
    assert z == 20 and 16 < y < 24 and 26 < x < 34 and got['off_plane_vox'] < 0.01  # inside the ring, on its slice
