/** Capture rendered scan pixels and overlays together with the state needed to reopen them. */
import type { Types } from "@cornerstonejs/core";
import type { Focus, Structure } from "@voluma/contracts/review";
import {
  type CreateReviewSnapshotRequest,
  MAX_REVIEW_SNAPSHOT_BYTES,
  type ReviewSnapshot,
  reviewSnapshotViewStateSchema,
} from "@voluma/contracts/snapshot";
import type { ReactNode } from "react";
import type { DicomSeries } from "./dicom";
import type { StructureDisplay } from "./labels";

export type CapturedSnapshot = Pick<CreateReviewSnapshotRequest, "id" | "viewState" | "pngBase64">;
export type SnapshotControls = {
  scopeKey: string;
  save(capture: CapturedSnapshot): Promise<void>;
  restore?: ReviewSnapshot;
  tray: ReactNode;
};

export async function scanGeometryFingerprint(series: DicomSeries) {
  const geometry = JSON.stringify([
    series.rows,
    series.columns,
    series.spacing,
    series.orientation,
    series.slices.map((slice) => slice.position),
  ]);
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(geometry));
  return Array.from(new Uint8Array(hash), (n) => n.toString(16).padStart(2, "0")).join("");
}

export async function captureAcquiredSnapshot(
  viewport: Types.IStackViewport,
  overlay: HTMLCanvasElement,
  series: DicomSeries,
  structures: Structure[],
  display: StructureDisplay,
  labelsEnabled: boolean,
  focus?: Focus,
): Promise<CapturedSnapshot> {
  const source = viewport.getCanvas();
  const camera = structuredClone(viewport.getCamera());
  if (camera.parallelProjection && camera.viewAngle === undefined) {
    // CPU stacks omit the perspective angle and return a placeholder eye at the origin.
    // For an orthographic view, eye distance and perspective angle do not affect projection.
    camera.viewAngle = 90;
    camera.position = camera.focalPoint!.map(
      (n, i) => n + camera.viewPlaneNormal![i]! * camera.parallelScale!,
    ) as Types.Point3;
  }
  const state = {
    version: 1,
    kind: "acquired",
    seriesId: series.id,
    sliceIndex: viewport.getCurrentImageIdIndex(),
    viewport: { width: source.width, height: source.height },
    camera,
    window: viewport.getProperties().voiRange,
    labelsEnabled,
    structures: structures.map((s) => ({
      structureId: s.id,
      visible: display[s.id]?.visible !== false,
      opacity: display[s.id]?.opacity ?? 100,
    })),
    focus,
  };
  if (source.width * source.height > 16_777_216 || !source.width || !source.height)
    throw new Error("Reduce the viewer size before taking a screenshot (maximum 16 megapixels).");
  // Copy both layers before the first await, so a later slice change cannot alter this capture.
  const canvas = document.createElement("canvas");
  canvas.width = source.width;
  canvas.height = source.height;
  const context = canvas.getContext("2d")!;
  context.drawImage(source, 0, 0);
  context.drawImage(overlay, 0, 0, canvas.width, canvas.height);
  const pngBase64 = canvas.toDataURL("image/png").split(",")[1]!;
  if (pngBase64.length > 4 * Math.ceil(MAX_REVIEW_SNAPSHOT_BYTES / 3))
    throw new Error("Reduce the viewer size before taking a screenshot (maximum PNG size 8 MiB).");
  const viewState = reviewSnapshotViewStateSchema.parse({
    ...state,
    scanGeometrySha256: await scanGeometryFingerprint(series),
  });
  return { id: crypto.randomUUID(), viewState, pngBase64 };
}
