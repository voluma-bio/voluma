/**
 * A design token's colour as #rrggbb. The tokens are written in oklch, which three.js `Color`
 * can't parse (it warns and falls back to black), so a 1×1 canvas resolves the browser's value.
 */
let ink: CanvasRenderingContext2D | null = null;

export function tokenColor(name: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  ink ??= document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
  ink.clearRect(0, 0, 1, 1);
  ink.fillStyle = value;
  ink.fillRect(0, 0, 1, 1);
  const [r, g, b] = ink.getImageData(0, 0, 1, 1).data;
  return `#${[r, g, b].map((v) => v!.toString(16).padStart(2, "0")).join("")}`;
}
