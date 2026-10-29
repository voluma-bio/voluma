"""The pinned environment works: every library imports and pyvista renders offscreen.

The default `vtk` wheel segfaults with no display, so this guards the vtk-osmesa pin.
Also: skills' modules share one import path, so a file name used in two skills' resources/ would shadow silently.
"""

import importlib
from collections import Counter
from pathlib import Path

import pytest

LIBRARIES = ["numpy", "scipy", "skimage", "pydicom", "nibabel", "SimpleITK", "matplotlib", "pyvista"]


@pytest.mark.parametrize("name", LIBRARIES)
def test_imports(name):
    importlib.import_module(name)


def test_pyvista_renders_offscreen(tmp_path):
    import pyvista as pv

    plotter = pv.Plotter(off_screen=True, window_size=(64, 64))
    plotter.add_mesh(pv.Sphere())
    out = tmp_path / "sphere.png"
    plotter.screenshot(out)
    plotter.close()
    assert out.stat().st_size > 0


def test_module_names_are_unique_across_skills():
    names = Counter(p.name for p in Path(__file__).parents[2].glob("*/skills/*/resources/*.py"))
    assert not [n for n, c in names.items() if c > 1], "the runner puts every resources/ on one PYTHONPATH"
