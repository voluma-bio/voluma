"""The pinned environment works: every library imports and pyvista renders offscreen.

The default `vtk` wheel segfaults with no display, so this guards the vtk-osmesa pin.
"""

import importlib

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
