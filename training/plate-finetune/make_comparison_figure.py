"""Render the README's growth-plate comparison figure: reference cut line, stock SAM 3.1 and the released fine-tune, per section.

  uv run --group figure python make_comparison_figure.py

Reads ~/experiments/plate-data (scans, the L32pub labels, the released band seeds' l33-prob-s* predictions) and the stock SAM 3.1
"growth plate" predictions in --stock (predict.py's output format, stock weights, threshold 0.3). Writes figures/plate-cut-comparison.png
(300 dpi) and the README's compressed .webp beside it. The µm numbers are score.py's per-section median cut-line distance.
"""
import argparse
import os
from pathlib import Path

import matplotlib as mpl
import matplotlib.pyplot as plt
import numpy as np
import scienceplots  # noqa: F401  (registers the "science" styles)
from matplotlib import patheffects
from matplotlib.lines import Line2D
from matplotlib.patches import Patch
from PIL import Image

import band_to_region
import cutline
import scans
import score

HERE = Path(__file__).resolve().parent
TEST_SCANS = {"OA8-19L", "OA6-9RK"}
EXPERT, AGENT = "expert-corrected", "agent-traced, not expert-checked"
# Mid-scan sections whose reference line crosses the whole tibia; OA8-19L's are among its 14 expert sections. The worst displayed
# fine-tune result is asserted in main() so a changed prediction cannot silently swap the honest worst case out.
ROWS = (
    ("OA8-19L", 64, EXPERT),
    ("OA8-19L", 118, EXPERT),
    ("OA8-19L", 208, EXPERT),
    ("OA6-9RK", 103, AGENT),
    ("OA6-11RK", 223, AGENT),
    ("OA7-2R", 150, AGENT),
    ("OA8-21L", 194, AGENT),
    ("OA6-5RK", 163, AGENT),
)
WORST = ("OA6-9RK", 103)
ASPECT = 0.42     # crop height / width, the same for every section
MARGIN = 6        # voxels of background either side of the tibia
SCALE_UM = 100
FILL_ALPHA = 0.6
# Okabe-Ito orange and sky blue: distinct for every colour-vision type, and both read on grey CT.
REFERENCE = "#E69F00"
FINE_TUNE = "#56B4E9"
STYLE = {
    "font.family": "sans-serif",
    "font.sans-serif": ["Arial", "Helvetica", "Liberation Sans", "DejaVu Sans"],
    "font.size": 7,
    "axes.titlesize": 7,
    "legend.fontsize": 7,
    "axes.linewidth": 0.5,
    "savefig.bbox": "standard",
    "image.interpolation": "lanczos",
}


def score_map(scan, prediction, label):
    rows = score.score_scan(scan, prediction, label)
    return {v: float(np.median(dist)) if len(dist) else None for v, (_, dist, _) in rows.items()}


def release_prediction(data_root, scan, tibia, label):
    """The release recipe: three band seeds at 0.3, midline cut, regions voted. -> (cut lines, plate bands, scores) per section.
    The plate is the band where two of the three seeds agree, unclipped like serve.py's band output: pieces on other bone stay in it,
    while the regions and their cut lines are built on the tibia only (labels.label_section)."""
    regions, bands, vs = [], [], None
    for seed in range(3):
        z = np.load(data_root / "finetune/preds" / f"l33-prob-s{seed}" / f"{scan}.npz")
        seed_vs = [int(v) for v in z["V"]]
        if vs is not None and seed_vs != vs:
            raise ValueError(f"release predictions cover different sections for {scan}")
        vs = seed_vs
        band = z["smax"].transpose(1, 0, 2) > 0.3
        bands.append(band)
        regions.append(band_to_region.band_regions(band, vs, tibia, "midline")[0])
    voted = np.stack(regions).sum(0) >= 2
    scores = score_map(scan, {"V": np.asarray(vs), "mask": voted}, label)
    plate = np.stack(bands).sum(0) >= 2
    lines = {v: cutline.cut_boundary(voted[i], cutline.envelope(tibia[:, v, :])) for i, v in enumerate(vs)}
    return lines, dict(zip(vs, plate)), scores


def stock_prediction(stock_root, scan, label):
    z = np.load(stock_root / f"{scan}.npz")
    empty = {int(v): not m.any() for v, m in zip(z["V"], z["mask"])}
    return empty, score_map(scan, {"V": z["V"], "mask": z["mask"]}, label)


def line_segments(mask):
    """A line mask -> (n, 2, 2) segments in (u, w) joining 8-adjacent line voxels, so the drawing runs only through the voxels
    themselves: two pieces in one column stay two pieces, never averaged into a line between them. A diagonal step is skipped where
    a shared 4-neighbour already joins the pair, and a voxel with no line neighbour is a zero-length segment (drawn as a dot)."""
    w, u = np.nonzero(mask)
    on = np.pad(mask, 1)
    segments = []
    for dw, du in ((0, 1), (1, 0), (1, 1), (1, -1)):
        hit = on[w + 1 + dw, u + 1 + du]
        if dw and du:
            hit &= ~on[w + 1 + dw, u + 1] & ~on[w + 1, u + 1 + du]
        segments.append(np.stack([np.stack([u[hit], w[hit]], 1), np.stack([u[hit] + du, w[hit] + dw], 1)], 1))
    near = np.zeros_like(on)
    for dw in (-1, 0, 1):
        for du in (-1, 0, 1):
            if dw or du:
                near[1:-1, 1:-1] |= on[1 + dw:on.shape[0] - 1 + dw, 1 + du:on.shape[1] - 1 + du]
    alone = ~near[w + 1, u + 1]
    segments.append(np.repeat(np.stack([u[alone], w[alone]], 1)[:, None], 2, 1))
    return np.concatenate(segments).astype(float)


def crop_box(env, reference):
    """[w0, w1) x [u0, u1): the tibia's width plus MARGIN, ASPECT tall, centred on the reference line."""
    cols = np.flatnonzero(env.any(0))
    u0, u1 = max(int(cols[0]) - MARGIN, 0), min(int(cols[-1]) + 1 + MARGIN, env.shape[1])
    height = round((u1 - u0) * ASPECT)
    centre = float(np.median(np.nonzero(reference)[0]))
    w0 = int(np.clip(round(centre - height / 2), 0, env.shape[0] - height))
    return w0, w0 + height, u0, u1


def show_section(ax, image, box):
    """Draw the cropped section in voxel coordinates: pixel (w, u) is centred on x=u, y=w, so every overlay uses data coordinates."""
    w0, w1, u0, u1 = box
    ax.imshow(image[w0:w1, u0:u1], cmap="gray", vmin=0, vmax=255, extent=(u0 - 0.5, u1 - 0.5, w1 - 0.5, w0 - 0.5))
    ax.set_xlim(u0 - 0.5, u1 - 0.5)
    ax.set_ylim(w1 - 0.5, w0 - 0.5)
    ax.set_aspect("equal")
    ax.set_xticks([])
    ax.set_yticks([])
    for spine in ax.spines.values():
        spine.set_visible(False)


def draw_line(ax, line, colour):
    halo = [patheffects.Stroke(linewidth=1.0, foreground="black", alpha=0.5), patheffects.Normal()]
    # One path with NaN breaks, not a LineCollection: a collection strokes each segment's halo over its neighbours' colour.
    segments = line_segments(line)
    path = np.concatenate([segments, np.full((len(segments), 1, 2), np.nan)], 1).reshape(-1, 2)
    ax.plot(path[:, 0], path[:, 1], color=colour, lw=0.5, solid_capstyle="round", solid_joinstyle="round", path_effects=halo)


def draw_fill(ax, mask, box, colour):
    w0, w1, u0, u1 = box
    rgba = np.zeros((w1 - w0, u1 - u0, 4))
    rgba[..., :3] = mpl.colors.to_rgb(colour)
    rgba[..., 3] = mask[w0:w1, u0:u1] * FILL_ALPHA
    ax.imshow(rgba, extent=(u0 - 0.5, u1 - 0.5, w1 - 0.5, w0 - 0.5), interpolation="nearest")


def corner_text(ax, text, colour):
    ax.text(0.025, 0.94, text, transform=ax.transAxes, ha="left", va="top", color=colour, fontsize=6,
            bbox={"boxstyle": "round,pad=0.25,rounding_size=0.15", "facecolor": "black", "alpha": 0.55, "linewidth": 0})


def scale_bar(ax, box):
    w0, w1, u0, u1 = box
    x1 = u1 - 0.5 - 0.03 * (u1 - u0)
    y = w1 - 0.5 - 0.09 * (w1 - w0)
    ax.plot([x1 - SCALE_UM / scans.UM, x1], [y, y], color="white", lw=1.5, solid_capstyle="butt",
            path_effects=[patheffects.withStroke(linewidth=2.5, foreground="black", alpha=0.7)])
    ax.text(x1 - SCALE_UM / scans.UM - 0.015 * (u1 - u0), y, f"{SCALE_UM} µm", color="white", fontsize=5.5, ha="right", va="center",
            path_effects=[patheffects.withStroke(linewidth=1.5, foreground="black", alpha=0.7)])


def load_rows(data_root, stock_root):
    """-> (rows, per-scan means): one row per ROWS entry, with score.py's per-section numbers."""
    rows, means = [], {}
    for scan in dict.fromkeys(row[0] for row in ROWS):
        split = "heldout" if scan in TEST_SCANS else "val"
        label = np.load(data_root / f"finetune/data/L32pub/{split}/labels/{scan}.npz")
        tibia = scans.load_tibia_mask(scan)
        volume = scans.load_vol(scan)
        lines, plates, scores = release_prediction(data_root, scan, tibia, label)
        stock_empty, stock_scores = stock_prediction(stock_root, scan, label)
        means[scan] = (np.mean([x for x in scores.values() if x is not None]), sum(stock_empty.values()), len(stock_empty),
                       np.mean([x for x in stock_scores.values() if x is not None]))
        cuts = dict(zip((int(v) for v in label["V"]), label["cut"]))
        for row_scan, v, source in ROWS:
            if row_scan != scan:
                continue
            if not stock_empty[v]:
                raise ValueError(f"stock SAM 3.1 returned a mask on {scan} V{v}; the panel would need to show it")
            rows.append({"scan": scan, "v": v, "source": source, "image": scans.section_img(volume, v)[:, :, 0],
                         "env": cutline.envelope(tibia[:, v, :]), "reference": cuts[v], "line": lines[v],
                         "plate": plates[v], "score": scores[v]})
    rows.sort(key=lambda row: ROWS.index((row["scan"], row["v"], row["source"])))
    worst = max(rows, key=lambda row: row["score"])
    if (worst["scan"], worst["v"]) != WORST:
        raise ValueError(f"expected the worst displayed section to be {WORST}, got {worst['scan']} V{worst['v']} ({worst['score']:.1f} µm)")
    return rows, means


def render(rows, out):
    plt.style.use(["science", "nature", "no-latex"])
    plt.rcParams.update(STYLE)
    width_in = 180 / 25.4                                   # a double-column figure
    label_w, gap, edge = 0.95, 0.04, 0.09                   # inches; edge: the right margin, matching the row labels' left one
    panel_w = (width_in - label_w - 2 * gap - edge) / 3
    panel_h = panel_w * ASPECT
    header, legend_h, row_gap = 0.3, 0.3, 0.045
    height_in = header + len(rows) * panel_h + (len(rows) - 1) * row_gap + legend_h
    fig = plt.figure(figsize=(width_in, height_in), dpi=300)
    grid = fig.add_gridspec(len(rows), 3, left=label_w / width_in, right=1 - edge / width_in, top=1 - header / height_in,
                            bottom=legend_h / height_in, wspace=gap / panel_w, hspace=row_gap / panel_h)
    titles = ("Reference cut line", 'Meta SAM 3.1 · prompt "growth plate"', 'Our fine-tune · prompt "growth plate"')

    for r, row in enumerate(rows):
        box = crop_box(row["env"], row["reference"])
        axes = [fig.add_subplot(grid[r, c]) for c in range(3)]
        for ax in axes:
            show_section(ax, row["image"], box)
        draw_line(axes[0], row["reference"], REFERENCE)
        scale_bar(axes[0], box)
        corner_text(axes[1], "no mask returned", "0.8")
        draw_fill(axes[2], row["plate"], box, FINE_TUNE)
        draw_line(axes[2], row["line"], FINE_TUNE)
        corner_text(axes[2], f"{row['score']:.1f} µm", "white")
        axes[0].text(-0.04, 0.5, f"{row['scan']} · V{row['v']}\n", transform=axes[0].transAxes, ha="right", va="center",
                     fontsize=7, fontweight="bold")
        axes[0].text(-0.04, 0.5, "\n" + row["source"].replace(", ", ",\n"), transform=axes[0].transAxes, ha="right", va="top",
                     fontsize=6, color="0.35", linespacing=1.15)
        if r == 0:
            for c, (ax, title) in enumerate(zip(axes, titles)):
                ax.text(0, 1.05, "abc"[c], transform=ax.transAxes, fontsize=8, fontweight="bold", va="bottom", ha="left")
                ax.text(0.05, 1.05, title, transform=ax.transAxes, fontsize=7, va="bottom", ha="left")

    handles = [
        Line2D([], [], color=REFERENCE, lw=1.0, label="Reference cut line"),
        Patch(facecolor=FINE_TUNE, alpha=FILL_ALPHA, edgecolor="none", label="Fine-tune growth plate"),
        Line2D([], [], color=FINE_TUNE, lw=1.0, label="Fine-tune cut line, with its distance to the reference"),
    ]
    fig.legend(handles=handles, loc="lower left", bbox_to_anchor=(label_w / width_in, 0), ncol=3, frameon=False,
               handlelength=1.6, columnspacing=1.6, borderaxespad=0.15)
    out.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(out, dpi=300, facecolor="white")
    plt.close(fig)
    with Image.open(out) as png:
        png.convert("RGB").save(out.with_suffix(".webp"), "WEBP", quality=90, method=6)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-root", type=Path, default=Path.home() / "experiments/plate-data")
    parser.add_argument("--stock", type=Path, default=Path.home() / "experiments/plate-figure/stock-growth-plate",
                        help='stock SAM 3.1 predictions with the prompt "growth plate", one npz per scan (predict.py format)')
    parser.add_argument("--out", type=Path, default=HERE / "figures/plate-cut-comparison.png")
    args = parser.parse_args()
    os.environ["PLATE_SCANS"] = str(args.data_root.expanduser() / "scans")
    rows, means = load_rows(args.data_root.expanduser(), args.stock.expanduser())
    render(rows, args.out)
    print(f"wrote {args.out} and {args.out.with_suffix('.webp')}")
    for row in rows:
        print(f"{row['scan']} V{row['v']}: fine-tune {row['score']:.1f} µm")
    for scan, (fine_tune, empty, n, stock) in means.items():
        print(f"{scan}: fine-tune mean {fine_tune:.1f} µm; stock SAM 3.1 empty on {empty} of {n} sections, mean {stock:.0f} µm")


if __name__ == "__main__":
    main()
