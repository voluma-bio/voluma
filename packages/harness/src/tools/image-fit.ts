/**
 * What a model is shown of an image: at most 1 MiB and 2000 px a side (the most Claude accepts once
 * a request holds many images). The `read` tool fits images with this.
 */
import sharp from "sharp";

export const MAX_BYTES = 1024 * 1024;
export const MAX_SIDE = 2000;

/** Fits the image in MAX_SIDE and MAX_BYTES: shrinks it, then lowers the JPEG quality, until it does. */
export async function downscale(bytes: Buffer, width: number, height: number) {
  let scale = Math.min(1, MAX_SIDE / Math.max(width, height));
  for (;;) {
    const size = {
      width: Math.max(1, Math.round(width * scale)),
      height: Math.max(1, Math.round(height * scale)),
    };
    for (const quality of [85, 70, 55]) {
      const out = await sharp(bytes)
        .autoOrient()
        .flatten({ background: "#ffffff" })
        .resize(size.width, size.height)
        .jpeg({ quality })
        .toBuffer();
      if (out.length <= MAX_BYTES) return { bytes: out, ...size };
    }
    scale *= 0.75;
  }
}
