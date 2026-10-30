/**
 * A composed slice picture and the textured quad that shows it in a slice pane. Corners are in
 * source voxels (z, y, x); the pane maps them to its own space.
 */
import {
  BufferAttribute,
  BufferGeometry,
  DataTexture,
  LinearFilter,
  NearestFilter,
  RGBAFormat,
  SRGBColorSpace,
} from "three";
import { type Axis, planeAxes, type Zyx } from "./scene";

/** `rows` × `cols` RGBA texels of one level (`scale` source voxels each), `axis` held at `index` (source voxels). */
export type Picture = {
  axis: Axis;
  index: number;
  rgba: Uint8Array;
  rows: number;
  cols: number;
  scale: number;
};

/**
 * The picture's corners: top left, top right, bottom left, bottom right. Source voxel i is
 * centred on i, so level voxel j spans [j·s − ½, (j+1)·s − ½).
 */
export function corners(picture: Picture): Zyx[] {
  const [ra, ca] = planeAxes(picture.axis);
  const at = (row: number, col: number): Zyx => {
    const p = [0, 0, 0];
    p[picture.axis] = picture.index;
    p[ra] = row;
    p[ca] = col;
    return p as unknown as Zyx;
  };
  const r1 = picture.rows * picture.scale - 0.5;
  const c1 = picture.cols * picture.scale - 0.5;
  return [at(-0.5, -0.5), at(-0.5, c1), at(r1, -0.5), at(r1, c1)];
}

/** A two-triangle quad over `points` (as `corners` orders them), with texture coordinates. */
export function quad(points: [number, number, number][]): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(new Float32Array(points.flat()), 3));
  geometry.setAttribute("uv", new BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), 2));
  geometry.setIndex([0, 2, 1, 1, 2, 3]);
  return geometry;
}

export function texture(picture: Picture, smooth: boolean): DataTexture {
  const t = new DataTexture(picture.rgba, picture.cols, picture.rows, RGBAFormat);
  t.colorSpace = SRGBColorSpace;
  t.magFilter = smooth ? LinearFilter : NearestFilter;
  t.minFilter = LinearFilter;
  t.needsUpdate = true;
  return t;
}
