/**
 * A view the researcher saves (`view.saved {output, view}`), as stored: `quad_view.py`'s
 * `.view.json` state keys where they mean the same thing (`version`, `center_zyx` in the grid's
 * voxels, `panes` with each slice pane's `normal`, `up` and `right` in mm (z, y, x) and the grid
 * `axis` it holds when untilted, `window`), the contract's `shown`, and under `review` what only the
 * four panes have: which grid, the layout, each view's zoom and centre or 3D camera, and the target
 * the planes were aligned to. Unlike `quad_view.py`'s, `center_zyx` is on the shown grid, not
 * always the scan's.
 */
import { z } from "zod";
import { type Basis, type Orientation, onGrid, orientationWords } from "./frame";
import type { QuadState, QuadView } from "./QuadViewer";
import type { Axis, Zyx } from "./scene";

const vec3 = z.tuple([z.number(), z.number(), z.number()]);
const view = z.enum(["3d", "xy", "xz", "yz", "gp"]);
const paneView = z.union([
  z.object({ zoom: z.number(), center: z.tuple([z.number(), z.number()]) }),
  z.object({ camera: z.object({ position: vec3, target: vec3, up: vec3 }) }),
]);

/** What the review reads back; anything else (a view an agent drew with quad_view.py) isn't reopened here. */
const storedSchema = z.object({
  center_zyx: vec3,
  window: z.tuple([z.number(), z.number()]).nullable(),
  panes: z.array(z.object({ normal: vec3, up: vec3, right: vec3 })).length(3),
  review: z.object({
    grid: z.string(),
    aligned: z.object({ id: z.string(), name: z.string() }).nullable(),
    layout: z.object({
      count: z.union([z.literal(1), z.literal(2), z.literal(4)]),
      views: z.array(view).length(4),
      full: view.nullable(),
    }),
    views: z.partialRecord(view, paneView),
  }),
});

export type StoredView = z.infer<typeof storedSchema> & { version: 2; shown: string[] };

/** The view to store: the panes as they are on the grid of image volume `grid`, showing `shown`. */
export function storeView(state: QuadState, grid: string, shown: readonly string[]): StoredView {
  return {
    version: 2,
    shown: [...shown],
    center_zyx: [...state.point],
    window: state.contrast && [state.contrast.low, state.contrast.high],
    // `axis` as quad_view.py has it: the grid axis an untilted pane holds; null when tilted.
    panes: state.orientation.map((b, axis) => ({
      normal: [...b.normal],
      up: [-b.down[0], -b.down[1], -b.down[2]],
      right: [...b.right],
      axis: onGrid(b, axis as Axis) ? axis : null,
    })),
    review: {
      grid,
      aligned: state.aligned,
      layout: { ...state.layout, views: [...state.layout.views] },
      views: state.views,
    },
  };
}

/** How a stored view's planes lie, in words (`orientationWords`); undefined on the grid's axes or when it isn't one this review saved. */
export function storedWords(stored: unknown): string | undefined {
  const parsed = storedSchema.safeParse(stored);
  if (!parsed.success) return undefined;
  return orientationWords(orientationOf(parsed.data.panes), parsed.data.review.aligned?.name);
}

const orientationOf = (panes: z.infer<typeof storedSchema>["panes"]) =>
  panes.map(
    (p): Basis => ({ normal: p.normal, right: p.right, down: [-p.up[0], -p.up[1], -p.up[2]] }),
  ) as unknown as Orientation;

/** A stored view of grid `grid` as the viewer restores it; undefined when it isn't one this review saved. */
export function readView(stored: unknown, grid: string): QuadState | undefined {
  const parsed = storedSchema.safeParse(stored);
  if (!parsed.success || parsed.data.review.grid !== grid) return undefined;
  const v = parsed.data;
  return {
    orientation: orientationOf(v.panes),
    aligned: v.review.aligned,
    point: v.center_zyx as Zyx,
    contrast: v.window && { low: v.window[0], high: v.window[1] },
    layout: v.review.layout as QuadState["layout"],
    views: v.review.views as Partial<Record<QuadView, QuadState["views"][QuadView]>>,
  };
}
