"""Where the inputs live and how a prepared scan is laid out; the section image the model sees.

Paths come from the environment (README "Inputs"): PLATE_SCANS (prepared scans), PLATE_PIECES (the reviewed
plateau-piece volumes, optional per scan) and SAM31_WEIGHTS (Meta's sam3.1_multiplex.pt).
A scan directory holds tgrid/tibia-hu.npy and tgrid/tibia-mask.npy (axes W, V, U; a coronal section is vol[:, V, :],
rows W, columns U), tgrid/tibia-frame.json (grid_id), trace/annotations.json (the traced plate faces), trace/ends.json
(optional line ends) and review.json (optional reviewer verdicts). Voxels are 10.5 µm.
"""
import json
import os
from pathlib import Path

import numpy as np

UM = 10.5
WINDOW = (-1000.0, 7000.0)  # HU -> 8 bit; bone saturates near 7000 in these scans, the plate is darker than bone


def env_path(name):
    if name not in os.environ:
        raise SystemExit(f"set {name} (see README.md, Inputs)")
    return Path(os.environ[name]).expanduser()


def scan_dir(scan):
    return env_path("PLATE_SCANS") / scan


def section_img(vol, v):
    """The model's input for section v: HU windowed to 8 bit, repeated in 3 channels, (W, U, 3)."""
    s = np.asarray(vol[:, v, :], dtype=np.float32)
    lo, hi = WINDOW
    u8 = (np.clip((s - lo) / (hi - lo), 0, 1) * 255).astype(np.uint8)
    return np.stack([u8] * 3, -1)


def load_vol(scan):
    return np.load(scan_dir(scan) / "tgrid/tibia-hu.npy", mmap_mode="r")


def load_tibia_mask(scan):
    return np.load(scan_dir(scan) / "tgrid/tibia-mask.npy", mmap_mode="r")


def grid_id(scan):
    return json.loads((scan_dir(scan) / "tgrid/tibia-frame.json").read_text())["grid_id"]


def load_curves(scan):
    """trace/annotations.json -> {V: (proximal, distal)} face polylines [[w, u], ...]; V with both faces only."""
    a = json.loads((scan_dir(scan) / "trace/annotations.json").read_text())
    p = a.get("growth_plate_curves", {}).get("slices", {})
    d = a.get("growth_plate_distal_curves", {}).get("slices", {})
    return {int(k): (np.array(p[k], float), np.array(d[k], float)) for k in p if k in d}


def load_ends(scan):
    """trace/ends.json: {V: {"left": [[w, u], ...], "right": [...]}}, {} if absent."""
    p = scan_dir(scan) / "trace/ends.json"
    return {int(v): e for v, e in json.loads(p.read_text()).items()} if p.exists() else {}


def load_reviews(scan):
    """review.json's sections: {V: {"verdict": good|bad|fixed, "cut"?: [[w, u], ...], "not_visible"?: [[u0, u1], ...]}}."""
    p = scan_dir(scan) / "review.json"
    return {int(k): r for k, r in json.loads(p.read_text())["sections"].items()} if p.exists() else {}


def load_pieces(scan):
    """The reviewed plateau pieces of a scan (ossicles, fragments), bool (W, V, U), or None when the scan has none."""
    p = env_path("PLATE_PIECES") / f"{scan}.npy"
    return np.load(p, mmap_mode="r") if p.exists() else None
