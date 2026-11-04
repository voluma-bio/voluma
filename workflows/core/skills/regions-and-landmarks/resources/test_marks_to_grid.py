"""The review's mm onto a grid: a wrong origin or spacing puts a researcher's mark thousands of voxels away and the worker
is refused, or (worse) a few voxels away and nothing says so; the same-grid and cross-grid maps are pinned."""

import json
import os
import subprocess
import sys
from pathlib import Path

import frame as fr
import numpy as np

SCRIPT = Path(__file__).with_name('marks_to_grid.py')
SCAN_AFFINE = np.array([[0.0105, 0, 0, 7.9], [0, 0.0105, 0, 4.7], [0, 0, 0.0105, 128.9], [0, 0, 0, 1]])  # origin far from 0, as on OA6-2RK


def headers(tmp):
    scan = {'grid_id': 'scan', 'spacing_zyx_mm': [0.0105] * 3, 'shape_zyx': [400, 400, 400],
            'affine_xyz_to_world_mm': SCAN_AFFINE.tolist()}
    th = np.radians(20)
    c, s = np.cos(th), np.sin(th)
    tibia = fr.make('scan', [0.0105] * 3, parent_affine_xyz=SCAN_AFFINE, R_zyx=[[c, s, 0], [-s, c, 0], [0, 0, 1]],
                    origin_zyx=[30.0, 20.0, 10.0], shape=[362, 344, 340])
    (tmp / 'hu.json').write_text(json.dumps(scan))
    fr.save(tibia, tmp / 'tibia-frame.json')
    return tibia


def review_mm(zyx):
    """What the review sends for voxels (z, y, x) of an image: index (x, y, z) times spacing, from voxel 0."""
    return np.asarray(zyx, float)[:, ::-1] * 0.0105


def world_line(xyz):
    return 'at ' + '–'.join(f'({x:.4f}, {y:.4f}, {z:.4f})' for x, y, z in xyz) + ' mm'


def run(*args):
    env = {**os.environ, 'PYTHONPATH': os.pathsep.join(sys.path)}  # the skills' resources, as the sandbox has them
    out = subprocess.run([sys.executable, str(SCRIPT), *map(str, args)], check=False, capture_output=True, text=True, env=env)
    assert out.returncode == 0, out.stderr
    return json.loads(out.stdout.strip().splitlines()[-1])


def test_a_line_drawn_on_the_tibia_grid_lands_on_its_section(tmp_path):
    headers(tmp_path)
    zyx = [[202.6, 172, 201.18], [200.93, 172, 226.2], [200.09, 172, 251.21], [202.6, 172, 276.23]]  # run 1f82654f's L1
    f = tmp_path / 'tibia-frame.json'
    got = run('--curve', '--world', world_line(review_mm(zyx)), '--drawn-on', f, '--grid', f, '--out', tmp_path / 'c.json')
    assert got['section'] == 172 and got['off_section_vox'] < 0.01
    assert got['points'][0] == [202.6, 201.2]


def test_a_mark_drawn_on_the_scan_lands_where_the_frame_puts_those_scan_voxels(tmp_path):
    tibia = headers(tmp_path)
    frame_zyx = np.array([[200.0, 172, 200], [201, 172, 230], [203, 172, 260]])
    scan_zyx = fr.to_scan_points(frame_zyx, tibia)
    got = run('--curve', '--world', world_line(review_mm(scan_zyx)), '--drawn-on', tmp_path / 'hu.json',
              '--grid', tmp_path / 'tibia-frame.json', '--out', tmp_path / 'c.json')
    assert got['section'] == 172 and got['off_section_vox'] < 0.01
    np.testing.assert_allclose(got['points'], frame_zyx[:, [0, 2]], atol=0.06)


def test_seed_on_the_scan_with_an_origin(tmp_path):
    headers(tmp_path)
    labels = np.zeros((40, 40, 40), np.uint16)
    labels[5:35, 5:35, 5:35] = 1
    np.save(tmp_path / 'labels.npy', labels)
    (tmp_path / 'labels.json').write_text(json.dumps({'grid_id': 'scan', 'spacing_zyx_mm': [0.0105] * 3}))
    ring = [[20, 16, 16], [20, 16, 24], [20, 24, 24], [20, 24, 16]]
    got = run('--seed', '--world', world_line(review_mm(ring)), '--drawn-on', tmp_path / 'hu.json', '--grid', tmp_path / 'hu.json',
              '--labels', tmp_path / 'labels.npy')
    z, y, x = got['seed_zyx']
    assert z == 20 and 16 < y < 24 and 16 < x < 24 and got['off_plane_vox'] < 0.01  # inside the ring, on its slice
