"""Render cross-scan cut-line examples from the local plate experiment outputs.

By default this reads ~/experiments/plate-data and writes the compressed figure used by
the README. The stock SAM 3.1 run returned an empty mask on every displayed section;
the figure renders that observed result as "nothing found".
"""
import argparse
import json
import os
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).resolve().parent
TEST_SCANS = {"OA8-19L", "OA6-9RK"}
ROWS = (
    ("OA8-19L", 34, "expert-corrected"),
    ("OA8-19L", 208, "expert-corrected"),
    ("OA6-9RK", 63, "agent-traced\nnot expert-checked"),
    ("OA6-9RK", 103, "agent-traced\nnot expert-checked"),
    ("OA6-11RK", 88, "agent-traced\nnot expert-checked"),
    ("OA7-2R", 55, "agent-traced\nnot expert-checked"),
    ("OA8-21L", 58, "agent-traced\nnot expert-checked"),
    ("OA6-5RK", 78, "agent-traced\nnot expert-checked"),
)
REFERENCE = (255, 214, 0, 255)
FINE_TUNE = (0, 220, 255, 255)
EMPTY = (255, 88, 88, 235)


def font(size, bold=False):
    name = "DejaVuSans-Bold.ttf" if bold else "DejaVuSans.ttf"
    for root in (Path("/usr/share/fonts/truetype/dejavu"), Path("/usr/share/fonts/truetype/liberation2")):
        path = root / name
        if path.exists():
            return ImageFont.truetype(path, size)
    return ImageFont.load_default()


def read_curves(path):
    data = json.loads(path.read_text())
    proximal = data.get("growth_plate_curves", {}).get("slices", {})
    distal = data.get("growth_plate_distal_curves", {}).get("slices", {})
    return {int(v): (np.asarray(proximal[v], float), np.asarray(distal[v], float)) for v in proximal if v in distal}


def trace_lines(root, sections, n_u):
    curves = read_curves(root / "trace/annotations.json")
    ends_path = root / "trace/ends.json"
    ends = {int(v): x for v, x in json.loads(ends_path.read_text()).items()} if ends_path.exists() else {}
    return {
        v: cutline.flatten(cutline.derive(*curves[v], n_u, ends.get(v)))
        for v in sections
        if v in curves
    }


def draw_line(draw, line, offset, fit, colour, width=3):
    if line is None:
        return
    points, gaps = line if isinstance(line, tuple) else (line, [])
    points = np.asarray(points, float)
    for a, b in zip(points[:-1], points[1:]):
        in_gap = any(g0 - 1 <= min(a[1], b[1]) <= max(a[1], b[1]) <= g1 + 1 for g0, g1 in gaps)
        xy = [
            ((a[1] - offset[1]) * fit[0], (a[0] - offset[0]) * fit[1]),
            ((b[1] - offset[1]) * fit[0], (b[0] - offset[0]) * fit[1]),
        ]
        draw.line(xy, fill=colour[:3] + ((110 if in_gap else colour[3]),), width=width)


def line_from_region(region, env):
    boundary = cutline.cut_boundary(region, env)
    points = []
    for u in range(boundary.shape[1]):
        rows = np.flatnonzero(boundary[:, u])
        if len(rows):
            points.append((float(np.median(rows)), float(u)))
    return np.asarray(points, float) if points else None


def crop_box(env):
    rows = np.flatnonzero(env.any(1))
    cols = np.flatnonzero(env.any(0))
    w0, w1 = max(int(rows[0]) - 8, 0), min(int(rows[-1]) + 9, env.shape[0])
    w1 = min(w1, w0 + 150)
    u0, u1 = max(int(cols[0]) - 8, 0), min(int(cols[-1]) + 9, env.shape[1])
    return w0, w1, u0, u1


def score_map(scan, prediction, labels):
    rows = score.score_scan(scan, prediction, labels)
    return {v: float(np.median(dist)) if len(dist) else None for v, (_, dist, _) in rows.items()}


def release_prediction(data_root, scan, tibia, labels):
    prediction_root = data_root / "finetune" / "preds"
    regions, vs = [], None
    for seed in range(3):
        z = np.load(prediction_root / f"l33-prob-s{seed}" / f"{scan}.npz")
        seed_vs = [int(v) for v in z["V"]]
        if vs is None:
            vs = seed_vs
        if seed_vs != vs:
            raise ValueError(f"release predictions cover different sections for {scan}")
        band = z["smax"].transpose(1, 0, 2) > 0.3
        region, _, _ = band_to_region.band_regions(band, vs, tibia, "midline")
        regions.append(region)
    voted = (np.stack(regions).sum(0) >= 1.5) & (np.stack(regions).sum(0) > 0)
    prediction = {"V": np.asarray(vs), "mask": voted}
    scores = score_map(scan, prediction, labels)
    lines = {v: line_from_region(voted[vs.index(v)], cutline.envelope(tibia[:, v, :])) for v in vs}
    return lines, scores


def panel(image, line, score_text, box, method):
    w0, w1, u0, u1 = box
    crop = image[w0:w1, u0:u1]
    height, width = crop.shape
    max_w, max_h = 345, 142
    fit_value = min(max_w / width, max_h / height)
    size = (max(1, round(width * fit_value)), max(1, round(height * fit_value)))
    base = Image.fromarray(crop).resize(size, Image.Resampling.LANCZOS).convert("RGBA")
    canvas = Image.new("RGBA", (max_w, max_h), (10, 12, 14, 255))
    left, top = (max_w - size[0]) // 2, (max_h - size[1]) // 2
    canvas.alpha_composite(base, (left, top))
    if line is not None:
        layer = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
        colour = REFERENCE if method == "reference" else FINE_TUNE
        draw_line(ImageDraw.Draw(layer, "RGBA"), line, (w0, u0), (fit_value, fit_value), colour)
        canvas.alpha_composite(layer, (left, top))
    if method == "untrained":
        draw = ImageDraw.Draw(canvas, "RGBA")
        draw.rounded_rectangle((max_w // 2 - 67, max_h // 2 - 24, max_w // 2 + 67, max_h // 2 + 24), radius=7, fill=(20, 22, 24, 220), outline=EMPTY, width=2)
        draw.text((max_w // 2, max_h // 2 - 9), "nothing found", font=font(13, True), fill=(255, 245, 240), anchor="mm")
    draw = ImageDraw.Draw(canvas, "RGBA")
    draw.rounded_rectangle((7, 7, 100, 30), radius=4, fill=(8, 10, 12, 205))
    draw.text((13, 10), score_text, font=font(12, True), fill=(255, 255, 255))
    return canvas.convert("RGB")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-root", type=Path, default=Path.home() / "experiments/plate-data")
    parser.add_argument("--out", type=Path, default=HERE / "figures/plate-cut-comparison.webp")
    args = parser.parse_args()
    data_root = args.data_root.expanduser()
    os.environ["PLATE_SCANS"] = str(data_root / "scans")
    sys.path.insert(0, str(HERE))
    global band_to_region, cutline, labels, scans, score
    import band_to_region
    import cutline
    import labels
    import scans
    import score

    scans_data = {}
    release_lines, release_scores = {}, {}
    reference_lines, labels_data = {}, {}
    for scan in sorted({row[0] for row in ROWS}):
        split = "heldout" if scan in TEST_SCANS else "val"
        label_path = data_root / f"finetune/data/L32pub/{split}/labels/{scan}.npz"
        labels_data[scan] = np.load(label_path)
        tibia = scans.load_tibia_mask(scan)
        volume = scans.load_vol(scan)
        scans_data[scan] = (volume, tibia)
        n_u = tibia.shape[2]
        if scan == "OA8-19L":
            reference_lines[scan], _ = labels.label_sections(scan)
        else:
            reference_lines[scan] = trace_lines(data_root / "scans" / scan, [v for row_scan, v, _ in ROWS if row_scan == scan], n_u)
        release_lines[scan], release_scores[scan] = release_prediction(data_root, scan, tibia, labels_data[scan])

    rows = []
    for scan, v, source in ROWS:
        reference = reference_lines[scan][v]
        release_score = release_scores[scan][v]
        rows.append((scan, v, source, reference, release_lines[scan][v], release_score))
    worst = max(rows, key=lambda row: row[5])
    if worst[:2] != ("OA8-21L", 58):
        raise ValueError(f"expected selected worst case OA8-21L V58, got {worst[0]} V{worst[1]} ({worst[5]:.1f} µm)")

    headers = [
        ('Expert labelled', "reference"),
        ('Meta SAM 3.1\nprompt "growth plate"', "untrained"),
        ('Our fine-tune\nprompt "growth plate"', "release"),
    ]
    row_h, row_gap, left, top, label_w, col_w, col_gap = 142, 14, 18, 92, 166, 345, 14
    width = left + label_w + len(headers) * col_w + (len(headers) - 1) * col_gap + left
    height = top + len(rows) * row_h + (len(rows) - 1) * row_gap + 94
    figure = Image.new("RGB", (width, height), (246, 244, 239))
    draw = ImageDraw.Draw(figure)
    draw.text((left, 18), "Growth-plate cut lines", font=font(24, True), fill=(25, 29, 32))
    draw.text((left, 48), "Six scans; each panel shows only its own line and its distance to that row's reference.", font=font(12), fill=(75, 80, 84))
    for i, (header, _) in enumerate(headers):
        x = left + label_w + i * (col_w + col_gap) + col_w // 2
        draw.multiline_text((x, top - 34), header, font=font(12, True), fill=(25, 29, 32), anchor="ma", align="center")

    for r, (scan, v, source, reference, release_line, release_score) in enumerate(rows):
        volume, tibia = scans_data[scan]
        box = crop_box(cutline.envelope(tibia[:, v, :]))
        image = scans.section_img(volume, v)[:, :, 0]
        row_y = top + r * (row_h + row_gap)
        label = f"{scan} V{v}\n{source}"
        draw.multiline_text((left + label_w - 8, row_y + row_h // 2), label, font=font(10, True), fill=(45, 49, 52), anchor="rm", align="right")
        panels = {
            "reference": (reference, "reference"),
            "untrained": (None, "1050.0 µm"),
            "release": (release_line, f"{release_score:.1f} µm"),
        }
        for c, (_, method) in enumerate(headers):
            line, score_text = panels[method]
            tile = panel(image, line, score_text, box, method)
            x = left + label_w + c * (col_w + col_gap)
            figure.paste(tile, (x, row_y))
            ImageDraw.Draw(figure).rectangle((x, row_y, x + col_w - 1, row_y + row_h - 1), outline=(205, 201, 194), width=1)

    legend_y = height - 68
    draw = ImageDraw.Draw(figure)
    draw.line((left + label_w, legend_y + 8, left + label_w + 23, legend_y + 8), fill=REFERENCE[:3], width=3)
    draw.text((left + label_w + 30, legend_y), "reference line", font=font(11), fill=(55, 60, 63))
    x = left + label_w + 145
    draw.line((x, legend_y + 8, x + 23, legend_y + 8), fill=FINE_TUNE[:3], width=3)
    draw.text((x + 30, legend_y), "our fine-tune", font=font(11), fill=(55, 60, 63))
    draw.text((left + label_w, legend_y + 28), "The stock SAM 3.1 returned no mask on every displayed section; empty sections score 1050 µm.", font=font(11), fill=(75, 80, 84))
    args.out.parent.mkdir(parents=True, exist_ok=True)
    figure.save(args.out, "WEBP", quality=88, method=6)
    print(f"wrote {args.out} ({figure.width}×{figure.height})")
    print("fine-tune worst displayed row:", worst[0], f"V{worst[1]}", f"{worst[5]:.1f} µm")
    for scan in sorted(release_scores):
        values = list(release_scores[scan].values())
        print(scan, f"mean={np.mean(values):.1f} µm")


if __name__ == "__main__":
    main()
