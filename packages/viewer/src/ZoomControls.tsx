/** Shared zoom buttons for acquired-slice and volume display controls. */
import { ZoomIn, ZoomOut } from "lucide-react";

export function ZoomControls({ label, onZoom }: { label: string; onZoom(factor: number): void }) {
  return (
    <div className="zoom-controls">
      <span className="text-muted-foreground">Zoom</span>
      <div className="flex gap-1">
        <button
          className="icon-button"
          type="button"
          aria-label={`${label} out`}
          title="Zoom out"
          onClick={() => onZoom(1 / 1.2)}
        >
          <ZoomOut size={16} aria-hidden="true" />
        </button>
        <button
          className="icon-button"
          type="button"
          aria-label={`${label} in`}
          title="Zoom in"
          onClick={() => onZoom(1.2)}
        >
          <ZoomIn size={16} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
