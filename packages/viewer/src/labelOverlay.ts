/** Paint native label pixels in the acquired viewport's world-to-canvas transform. */
import type { Types } from "@cornerstonejs/core";
import type { Focus, Structure } from "@voluma/contracts/review";
import type { DicomSeries } from "./dicom";
import { type LabelVolume, type StructureDisplay, scanWorld } from "./labels";

export function labelColor(style: CSSStyleDeclaration, label: number) {
  return style.getPropertyValue(`--label-${((label - 1) % 12) + 1}`).trim();
}

export function drawLabels(
  canvas: HTMLCanvasElement,
  viewport: Types.IStackViewport,
  series: DicomSeries,
  z: number,
  layers: LabelVolume[],
  structures: Structure[],
  display: StructureDisplay,
  focus: Focus | undefined,
  enabled: boolean,
) {
  const host = canvas.parentElement!;
  const dpr = devicePixelRatio;
  canvas.width = Math.round(host.clientWidth * dpr);
  canvas.height = Math.round(host.clientHeight * dpr);
  const ctx = canvas.getContext("2d")!;
  const style = getComputedStyle(canvas);
  const scratch = document.createElement("canvas");
  scratch.width = series.columns;
  scratch.height = series.rows;
  const pixels = scratch.getContext("2d", { willReadFrequently: true })!;
  const rgb = (color: string) => {
    pixels.clearRect(0, 0, 1, 1);
    pixels.fillStyle = color;
    pixels.fillRect(0, 0, 1, 1);
    return pixels.getImageData(0, 0, 1, 1).data;
  };
  const amber = rgb(style.getPropertyValue("--check-outline"));
  for (const layer of layers) {
    const [, height, width] = layer.volume.shapeZyx;
    const image = pixels.createImageData(width, height);
    const colors = new Map<number, { rgb: Uint8ClampedArray; opacity: number; focused: boolean }>();
    for (const [label] of Object.entries(layer.bounds)) {
      const value = Number(label);
      const structure = structures.find(
        (s) =>
          s.volumeId === layer.volume.id &&
          s.voxels !== null &&
          "label" in s.voxels &&
          s.voxels.label === value,
      );
      const focused =
        (focus?.volumeId === layer.volume.id &&
          (focus.label === undefined || focus.label === value)) ||
        !!(structure && focus?.on.includes(structure.id));
      const settings = structure ? display[structure.id] : undefined;
      if ((enabled && structure && settings?.visible !== false) || focused)
        colors.set(value, {
          rgb: rgb(labelColor(style, value)),
          opacity:
            structure && settings?.visible !== false && enabled
              ? (settings?.opacity ?? 100) / 100
              : 0,
          focused,
        });
    }
    const begin = z * width * height;
    for (let y = 0, i = 0; y < height; y++)
      for (let x = 0; x < width; x++, i++) {
        const value = layer.values[begin + i]!;
        const color = colors.get(value);
        if (!color) continue;
        const edge =
          x === 0 ||
          y === 0 ||
          x === width - 1 ||
          y === height - 1 ||
          [-1, 1, -width, width].some((d) => layer.values[begin + i + d] !== value);
        const rgba = color.focused && edge ? amber : color.rgb;
        image.data.set(
          [
            rgba[0]!,
            rgba[1]!,
            rgba[2]!,
            Math.round(255 * (color.focused && edge ? 1 : color.opacity * (edge ? 0.85 : 0.35))),
          ],
          i * 4,
        );
      }
    pixels.putImageData(image, 0, 0);
    const p = viewport.worldToCanvas(scanWorld(series, [z, -0.5, -0.5]));
    const x = viewport.worldToCanvas(scanWorld(series, [z, -0.5, 0.5]));
    const y = viewport.worldToCanvas(scanWorld(series, [z, 0.5, -0.5]));
    ctx.setTransform(
      (x[0] - p[0]) * dpr,
      (x[1] - p[1]) * dpr,
      (y[0] - p[0]) * dpr,
      (y[1] - p[1]) * dpr,
      p[0] * dpr,
      p[1] * dpr,
    );
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(scratch, 0, 0);
  }
  if (!focus) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.strokeStyle = style.getPropertyValue("--check-outline").trim();
  ctx.lineWidth = 2;
  const point = (y: number, x: number) => viewport.worldToCanvas(scanWorld(series, [z, y, x]));
  if (focus.box && z >= focus.box.min[0] && z <= focus.box.max[0]) {
    const { min, max } = focus.box;
    const corners = [
      point(min[1] - 0.5, min[2] - 0.5),
      point(min[1] - 0.5, max[2] + 0.5),
      point(max[1] + 0.5, max[2] + 0.5),
      point(max[1] + 0.5, min[2] - 0.5),
    ];
    ctx.beginPath();
    corners.forEach((p, i) => {
      if (i) ctx.lineTo(p[0], p[1]);
      else ctx.moveTo(p[0], p[1]);
    });
    ctx.closePath();
    ctx.stroke();
  }
  if (focus.point?.[0] === z) {
    const p = point(focus.point[1], focus.point[2]);
    ctx.beginPath();
    ctx.moveTo(p[0] - 8, p[1]);
    ctx.lineTo(p[0] + 8, p[1]);
    ctx.moveTo(p[0], p[1] - 8);
    ctx.lineTo(p[0], p[1] + 8);
    ctx.stroke();
  }
}
