/**
 * A design token's colour as #rrggbb. The tokens are written in oklch, which three.js `Color`
 * can't parse (it warns and falls back to black), so a 1×1 canvas resolves the browser's value.
 */
let ink: CanvasRenderingContext2D | null = null;

/** What the canvas holds for `value` once `before` was set: an unparseable value leaves `before`. */
function resolve(ctx: CanvasRenderingContext2D, value: string, before: string) {
  ctx.fillStyle = before;
  ctx.fillStyle = value;
  return ctx.fillStyle;
}

export function tokenColor(name: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  ink ??= document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
  // A canvas keeps its previous fillStyle when it can't parse the new one, which would pass the
  // last token's colour off as this one's: a parseable value ends the same from either start.
  if (!value || resolve(ink, value, "#000") !== resolve(ink, value, "#fff"))
    throw new Error(`Design token ${name} is not a colour: "${value}"`);
  ink.clearRect(0, 0, 1, 1);
  ink.fillStyle = value;
  ink.fillRect(0, 0, 1, 1);
  const [r, g, b] = ink.getImageData(0, 0, 1, 1).data;
  return `#${[r, g, b].map((v) => v!.toString(16).padStart(2, "0")).join("")}`;
}
