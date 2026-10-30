/**
 * "Open in 3D": a panel over the page that walks a queue of To check items one at a time in the
 * grid viewer. Pages pass only the queue; the panel fetches each run through `@voluma/api-client`.
 * The panel, three.js and the zarr reader load on its first render, never with the page.
 * An app that renders it must let Tailwind scan this package (`@source`).
 */
import { lazy, Suspense } from "react";
import type { CheckPanelProps } from "./types";

export type { CheckItem, CheckPanelProps } from "./types";

const Panel = lazy(() => import("./check-panel").then((m) => ({ default: m.CheckPanel })));

export function CheckPanel(props: CheckPanelProps) {
  return (
    <Suspense
      fallback={
        <p
          role="status"
          className="fixed top-4 right-4 rounded-lg border border-border bg-card px-4 py-2 text-ui text-muted-foreground shadow-md"
        >
          Opening the 3D view…
        </p>
      }
    >
      <Panel {...props} />
    </Suspense>
  );
}
