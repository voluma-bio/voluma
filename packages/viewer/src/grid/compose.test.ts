/** Where a cropped, downsampled overlay lands on the image: a one-voxel slip would look plausible. */
import { describe, expect, it } from "vitest";
import { compose } from "./compose";
import type { Plane } from "./planes";
import type { Overlay } from "./scene";

const black = (rows: number, cols: number): Plane => ({
  data: new Int16Array(rows * cols),
  rows,
  cols,
  shape: [],
});
const mask = (offsetZyx: [number, number, number]): Overlay => ({
  id: "m",
  name: "m",
  base: "",
  levels: [],
  offsetZyx,
  color: "#ffffff",
  opacity: 1,
});
/** 1 where the overlay coloured the pixel. */
const painted = (rgba: Uint8Array, rows: number, cols: number) =>
  Array.from({ length: rows }, (_, r) =>
    Array.from({ length: cols }, (_, c) => (rgba[(r * cols + c) * 4]! > 0 ? 1 : 0)).join(""),
  );

describe("compose", () => {
  it("places a level-1 mask crop at its offset on a full-resolution image", () => {
    // Crop at (y 1, x 2); level voxels (0, 0) and (1, 1) are set, each 2 × 2 source voxels.
    const overlay = { data: new Uint8Array([1, 0, 0, 1]), rows: 2, cols: 2, shape: [] };
    const rgba = compose(black(4, 6), 1, 0, { low: 0, high: 1 }, [
      { overlay: mask([0, 1, 2]), plane: overlay, scale: 2 },
    ]);
    expect(painted(rgba, 4, 6)).toEqual(["000000", "001100", "001100", "000011"]);
  });

  it("samples a full-resolution mask at the centre of each coarse image voxel", () => {
    // Crop rows 1–3, columns 2–3 in source voxels; image voxel (r, c) is centred on (2r + ½, 2c + ½).
    const overlay = { data: new Uint8Array(6).fill(1), rows: 3, cols: 2, shape: [] };
    const rgba = compose(black(2, 3), 2, 0, { low: 0, high: 1 }, [
      { overlay: mask([0, 1, 2]), plane: overlay, scale: 1 },
    ]);
    expect(painted(rgba, 2, 3)).toEqual(["000", "010"]);
  });
});
