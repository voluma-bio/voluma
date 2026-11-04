"""Render a labeled OA8-19L comparison from the local plate experiment outputs.

The public repository does not contain the lab scan or predictions. By default this reads
~/experiments/plate-data, reuses the released band predictions and Spark traces, and writes
figures/oa8-19l-cut-comparison.webp.
"""
import argparse
import json
import os
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).resolve().parent
SCAN = "OA8-19L"
SECTIONS = (34, 64, 118, 208, 262)
UM = 10.5
METHODS = {
    "image": "spark",
    "text": "text-only",
    "text+image": "text-plus-images",
    "text grid": "text-grid",
}
COLOURS = {
    "expert": (255, 214, 0, 220),
    "untrained": (255, 88, 88, 235),
    "spark": (255, 82, 82, 255),
    "opus": (65, 150, 255, 255),
    "release": (0, 220, 255, 255),
}


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


def lines_from_trace(root, sections, n_u):
    curves = read_curves(root / "trace/annotations.json")
    ends_path = root / "trace/ends.json"
    ends = {int(v): x for v, x in json.loads(ends_path.read_text()).items()} if ends_path.exists() else {}
    return {
        v: cutline.flatten(cutline.derive(*curves[v], n_u, ends.get(v)))
        for v in sections
        if v in curves
    }


def add_line(draw, line, offset, scale, colour, width=2):
    if line is None:
        return
    points, gaps = line if isinstance(line, tuple) else (line, [])
    points = np.asarray(points, float)
    for a, b in zip(points[:-1], points[1:]):
        gap = any(g0 - 1 <= min(a[1], b[1]) <= max(a[1], b[1]) <= g1 + 1 for g0, g1 in gaps)
        xy = [
            ((a[1] - offset[1]) * scale[0], (a[0] - offset[0]) * scale[1]),
            ((b[1] - offset[1]) * scale[0], (b[0] - offset[0]) * scale[1]),
        ]
        draw.line(xy, fill=colour[:3] + ((105 if gap else colour[3]),), width=width)


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


def load_release(data_root, tibia, labels):
    prediction_root = data_root / "finetune" / "preds"
    regions = []
    lines = []
    vs = None
    for seed in range(3):
        z = np.load(prediction_root / f"l33-prob-s{seed}" / f"{SCAN}.npz")
        this_vs = [int(v) for v in z["V"]]
        if vs is None:
            vs = this_vs
        if this_vs != vs:
            raise ValueError("release predictions cover different sections")
        band = z["smax"].transpose(1, 0, 2) > 0.3
        region, seed_lines, _ = band_to_region.band_regions(band, vs, tibia, "midline")
        regions.append(region)
        lines.append(seed_lines)
    voted = (np.stack(regions).sum(0) >= 1.5) & (np.stack(regions).sum(0) > 0)
    prediction = {"V": np.asarray(vs), "mask": voted}
    scores = score_map(SCAN, prediction, labels)
    voted_lines = {}
    for v in vs:
        i = vs.index(v)
        voted_lines[v] = line_from_region(voted[i], cutline.envelope(tibia[:, v, :]))
    return voted_lines, scores


def panel(image, expert_line, method_line, score_text, box, method):
    w0, w1, u0, u1 = box
    crop = image[w0:w1, u0:u1]
    height, width = crop.shape
    max_w, max_h = 252, 188
    fit = min(max_w / width, max_h / height)
    size = (max(1, round(width * fit)), max(1, round(height * fit)))
    base = Image.fromarray(crop).resize(size, Image.Resampling.LANCZOS).convert("RGBA")
    canvas = Image.new("RGBA", (max_w, max_h), (10, 12, 14, 255))
    left, top = (max_w - size[0]) // 2, (max_h - size[1]) // 2
    canvas.alpha_composite(base, (left, top))
    draw = ImageDraw.Draw(canvas, "RGBA")
    offset = (w0, u0)
    panel_scale = (fit, fit)
    expert = np.asarray(expert_line[0], float) if isinstance(expert_line, tuple) else np.asarray(expert_line, float)
    shifted = ImageDraw.Draw(canvas, "RGBA")
    # The reference is intentionally faint and remains visible under every prediction.
    old = shifted
    ref_points = np.asarray(expert, float).copy()
    ref_points[:, 0] = (ref_points[:, 0] - w0) * fit + left
    ref_points[:, 1] = (ref_points[:, 1] - u0) * fit + top
    for a, b in zip(ref_points[:-1], ref_points[1:]):
        old.line([(a[1], a[0]), (b[1], b[0])], fill=COLOURS["expert"], width=2)
    if method_line is not None and method != "expert":
        layer = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
        add_line(ImageDraw.Draw(layer, "RGBA"), method_line, offset, panel_scale, COLOURS[method], width=3)
        canvas.alpha_composite(layer, (left, top))
    if method == "untrained":
        draw.rounded_rectangle((max_w // 2 - 65, max_h // 2 - 26, max_w // 2 + 65, max_h // 2 + 26), radius=7, fill=(20, 22, 24, 220), outline=COLOURS["untrained"], width=2)
        draw.text((max_w // 2, max_h // 2 - 10), "nothing found", font=font(13, True), fill=(255, 245, 240), anchor="mm")
    draw.rounded_rectangle((7, 7, 93, 30), radius=4, fill=(8, 10, 12, 205))
    draw.text((13, 10), score_text, font=font(12, True), fill=(255, 255, 255))
    return canvas.convert("RGB")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-root", type=Path, default=Path.home() / "experiments/plate-data")
    parser.add_argument("--out", type=Path, default=HERE / "figures/oa8-19l-cut-comparison.webp")
    parser.add_argument("--sections", default=",".join(map(str, SECTIONS)))
    args = parser.parse_args()
    data_root = args.data_root.expanduser()
    sections = [int(v) for v in args.sections.split(",")]
    os.environ["PLATE_SCANS"] = str(data_root / "scans")
    sys.path.insert(0, str(HERE))
    global band_to_region, cutline, labels, scans, score
    import band_to_region
    import cutline
    import labels
    import scans
    import score

    volume = scans.load_vol(SCAN)
    tibia = scans.load_tibia_mask(SCAN)
    labels_file = data_root / "finetune/data/L16C4/heldout/labels/OA8-19L.npz"
    labels_data = np.load(labels_file)
    expert, _ = labels.label_sections(SCAN)
    n_u = tibia.shape[2]
    agent = lines_from_trace(data_root / "scans" / SCAN, sections, n_u)
    spark_scores = {}
    spark_lines = {}
    for display, directory in METHODS.items():
        score_file = data_root / "spark" / directory / "scores.json"
        if not score_file.exists():
            continue
        score_data = json.loads(score_file.read_text())["spark"]
        spark_scores[display] = score_data
        if display == "text":
            spark_lines = lines_from_trace(data_root / "spark" / directory / SCAN, sections, n_u)
    best_spark = min(spark_scores, key=lambda name: spark_scores[name]["med_sec"])
    if best_spark != "text":
        spark_lines = lines_from_trace(data_root / "spark" / METHODS[best_spark] / SCAN, sections, n_u)
    release_lines, release_scores = load_release(data_root, tibia, labels_data)
    agent_score_data = json.loads((data_root / "spark/scores.json").read_text())["opus"]
    scores = {
        "expert": {int(v): 0.0 for v in labels_data["V"]},
        "untrained": {int(v): 1050.0 for v in labels_data["V"]},
        "spark": {int(v): float(x) for v, x in spark_scores[best_spark]["per"].items()},
        "opus": {int(v): float(x) for v, x in agent_score_data["per"].items()},
        "release": release_scores,
    }
    means = {name: float(np.mean(list(values.values()))) for name, values in scores.items()}
    if abs(means["release"] - 16.4) > 0.05:
        raise ValueError(f"release vote is {means['release']:.3f} µm, not the README's 16.4 µm")

    headers = [
        ("Expert", "expert"),
        ('SAM 3.1\nuntrained', "untrained"),
        (f"Muse Spark\n{best_spark}", "spark"),
        ("Opus agent\ntrace", "opus"),
        ("Released model\n3-seed vote", "release"),
    ]
    row_h, row_gap, left, top, label_w, col_w, col_gap = 188, 23, 18, 74, 74, 252, 12
    width = left + label_w + len(headers) * col_w + (len(headers) - 1) * col_gap + left
    height = top + len(sections) * row_h + (len(sections) - 1) * row_gap + 105
    figure = Image.new("RGB", (width, height), (246, 244, 239))
    draw = ImageDraw.Draw(figure)
    draw.text((left, 18), "OA8-19L growth-plate cut line", font=font(24, True), fill=(25, 29, 32))
    draw.text((left, 47), "Gold: Dr. Yao's corrected line in every panel. Colour: the method's line.", font=font(12), fill=(75, 80, 84))
    for i, (header, _) in enumerate(headers):
        x = left + label_w + i * (col_w + col_gap) + col_w // 2
        draw.multiline_text((x, top - 51), header, font=font(12, True), fill=(25, 29, 32), anchor="ma", align="center")
    for r, v in enumerate(sections):
        env = cutline.envelope(tibia[:, v, :])
        box = crop_box(env)
        image = scans.section_img(volume, v)[:, :, 0]
        row_y = top + r * (row_h + row_gap)
        verdict = "end" if v in (sections[0], sections[-1]) else ""
        draw.text((left + label_w - 8, row_y + row_h // 2), f"V{v}\n{verdict}".rstrip(), font=font(12, True), fill=(45, 49, 52), anchor="rm", align="right")
        for c, (_, method) in enumerate(headers):
            line = {
                "expert": expert[v],
                "untrained": None,
                "spark": spark_lines.get(v),
                "opus": agent.get(v),
                "release": release_lines.get(v),
            }[method]
            score_value = scores[method].get(v)
            score_text = "reference" if method == "expert" else f"{score_value:.1f} µm" if score_value is not None else "—"
            tile = panel(image, expert[v], line, score_text, box, method)
            x = left + label_w + c * (col_w + col_gap)
            figure.paste(tile, (x, row_y))
            ImageDraw.Draw(figure).rectangle((x, row_y, x + col_w - 1, row_y + row_h - 1), outline=(205, 201, 194), width=1)
    legend_y = height - 83
    draw = ImageDraw.Draw(figure)
    legend = [("expert", "expert line"), ("spark", "Spark"), ("opus", "Opus"), ("release", "released model")]
    x = left + label_w
    for key, text in legend:
        draw.line((x, legend_y + 8, x + 22, legend_y + 8), fill=COLOURS[key][:3], width=3)
        draw.text((x + 29, legend_y), text, font=font(11), fill=(55, 60, 63))
        x += 125 if key != "release" else 170
    draw.text((left + label_w, legend_y + 28), "Untrained SAM 3.1 returns no mask on all 14 expert sections; its empty-section score is 1050 µm.", font=font(11), fill=(75, 80, 84))
    args.out.parent.mkdir(parents=True, exist_ok=True)
    figure.save(args.out, "WEBP", quality=88, method=6)
    print(f"wrote {args.out} ({figure.width}×{figure.height})")
    print("best Spark variant:", best_spark)
    print("means (all 14 sections):", " ".join(f"{name}={value:.1f} µm" for name, value in means.items()))
    print("release per section:", " ".join(f"V{v}={release_scores[v]:.1f}" for v in sorted(release_scores)))


if __name__ == "__main__":
    main()
