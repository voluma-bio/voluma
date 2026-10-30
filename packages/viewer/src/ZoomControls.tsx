/** Shared zoom buttons for acquired-slice and volume display controls. */
import { IconButton } from "@voluma/ui";
import { ZoomIn, ZoomOut } from "lucide-react";

export function ZoomControls({ label, onZoom }: { label: string; onZoom(factor: number): void }) {
  return (
    <div className="zoom-controls">
      <span className="text-muted-foreground">Zoom</span>
      <div className="flex gap-1">
        <IconButton variant="secondary" label={`${label} out`} onClick={() => onZoom(1 / 1.2)}>
          <ZoomOut aria-hidden="true" />
        </IconButton>
        <IconButton variant="secondary" label={`${label} in`} onClick={() => onZoom(1.2)}>
          <ZoomIn aria-hidden="true" />
        </IconButton>
      </div>
    </div>
  );
}
