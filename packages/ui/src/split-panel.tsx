/**
 * Two panes with a draggable divider: the review's task panel beside the
 * views, the workflow screen's side columns, and nested splits for the views.
 *
 * The first pane has a size in px; the second takes the rest. Panes stay
 * mounted while resizing (only a CSS size changes), which the 3D and slice
 * views depend on. The divider also moves with the arrow keys.
 */
import {
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  useCallback,
  useRef,
  useState,
} from "react";
import { cx } from "./cx";

export type SplitPanelProps = {
  /** `horizontal` puts the panes side by side; `vertical` stacks them. */
  direction?: "horizontal" | "vertical";
  /** Initial size of the first pane, in px. */
  defaultSize: number;
  minSize?: number;
  maxSize?: number;
  /** The second pane never shrinks below this, in px, even when the container does. */
  minRestSize?: number;
  /** Accessible name for the divider, e.g. "Resize task panel". */
  label: string;
  first: ReactNode;
  second: ReactNode;
  onSizeChange?: (size: number) => void;
  className?: string;
};

const KEY_STEP = 16;

export function SplitPanel({
  direction = "horizontal",
  defaultSize,
  minSize = 120,
  maxSize = Number.POSITIVE_INFINITY,
  minRestSize = 120,
  label,
  first,
  second,
  onSizeChange,
  className,
}: SplitPanelProps) {
  const [size, setSize] = useState(defaultSize);
  const [dragging, setDragging] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const horizontal = direction === "horizontal";

  const resize = useCallback(
    (next: number) => {
      const container = containerRef.current;
      if (!container) return;
      const extent = horizontal ? container.clientWidth : container.clientHeight;
      const clamped = Math.round(
        Math.max(minSize, Math.min(next, maxSize, extent - minRestSize)),
      );
      setSize(clamped);
      onSizeChange?.(clamped);
    },
    [horizontal, minSize, maxSize, minRestSize, onSizeChange],
  );

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!dragging || !containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    resize(horizontal ? event.clientX - rect.left : event.clientY - rect.top);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const back = horizontal ? "ArrowLeft" : "ArrowUp";
    const forward = horizontal ? "ArrowRight" : "ArrowDown";
    if (event.key === back) resize(size - KEY_STEP);
    else if (event.key === forward) resize(size + KEY_STEP);
    else return;
    event.preventDefault();
  };

  // The container may shrink below the stored size; CSS keeps the rest pane visible.
  const firstTrack = `min(${size}px, calc(100% - ${minRestSize}px))`;

  return (
    <div
      ref={containerRef}
      className={cx("relative grid h-full min-h-0 w-full min-w-0", className)}
      style={
        horizontal
          ? { gridTemplateColumns: `${firstTrack} minmax(0, 1fr)` }
          : { gridTemplateRows: `${firstTrack} minmax(0, 1fr)` }
      }
    >
      <div className="min-h-0 min-w-0 overflow-hidden">{first}</div>
      <div className="min-h-0 min-w-0 overflow-hidden">{second}</div>
      {/* biome-ignore lint/a11y/useSemanticElements: an <hr> cannot be focused or dragged; the ARIA separator pattern is the standard for resizable splits. */}
      <div
        role="separator"
        aria-label={label}
        aria-orientation={horizontal ? "vertical" : "horizontal"}
        aria-valuenow={size}
        aria-valuemin={minSize}
        aria-valuemax={Number.isFinite(maxSize) ? maxSize : undefined}
        tabIndex={0}
        data-dragging={dragging || undefined}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={() => setDragging(false)}
        onPointerCancel={() => setDragging(false)}
        onKeyDown={onKeyDown}
        className={cx(
          "absolute z-10 touch-none bg-clip-content transition-colors",
          "hover:bg-accent/35 focus-visible:bg-accent/35 focus-visible:outline-none data-dragging:bg-accent/35",
          horizontal
            ? "top-0 bottom-0 -ml-[5px] w-2.5 cursor-col-resize px-1"
            : "right-0 left-0 -mt-[5px] h-2.5 cursor-row-resize py-1",
        )}
        style={horizontal ? { left: firstTrack } : { top: firstTrack }}
      />
    </div>
  );
}
