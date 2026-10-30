/** Acquired-slice viewport. Cornerstone owns pixel decoding, modality/VOI transforms and pixel aspect ratio. */
import { Enums, getShouldUseCPURendering, RenderingEngine, type Types } from "@cornerstonejs/core";
import type { Focus, Structure } from "@voluma/contracts/review";
import { Camera } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { DicomSeries } from "./dicom";
import { acquireDicomSession, type DicomSession, initializeDicom } from "./dicomSession";
import { drawLabels } from "./labelOverlay";
import { type LabelVolume, type StructureDisplay, scanWorld } from "./labels";
import {
  type CapturedSnapshot,
  captureAcquiredSnapshot,
  type SnapshotControls,
  scanGeometryFingerprint,
} from "./snapshot";
import { ZoomControls } from "./ZoomControls";

export default function DicomStack({
  series,
  layers,
  structures,
  display,
  focus,
  labels,
  snapshots,
  labelsPending = false,
}: {
  series: DicomSeries;
  layers: LabelVolume[];
  structures: Structure[];
  display: StructureDisplay;
  focus?: Focus;
  labels: boolean;
  snapshots?: SnapshotControls;
  labelsPending?: boolean;
}) {
  const element = useRef<HTMLDivElement>(null);
  const overlay = useRef<HTMLCanvasElement>(null);
  const controls = useRef<{
    viewport: Types.IStackViewport;
    seek(index: number): Promise<void>;
  } | null>(null);
  const [index, setIndex] = useState(0);
  const [status, setStatus] = useState("Preparing image viewer…");
  const [error, setError] = useState(false);
  const [ready, setReady] = useState(false);
  const [window, setWindow] = useState({ width: "1", center: "0" });
  const [retry, setRetry] = useState(0);
  const [saving, setSaving] = useState(false);
  const [snapshotError, setSnapshotError] = useState<string>();
  const [restoring, setRestoring] = useState(false);
  const [frameRatio, setFrameRatio] = useState<number>();
  const busy = useRef(false);
  const pendingCapture = useRef<{ scopeKey: string; capture: CapturedSnapshot } | null>(null);
  const restore = snapshots?.restore;

  useEffect(() => {
    if (!ready || !focus?.point || restore) return;
    controls.current?.seek(focus.point[0]);
    const view = controls.current?.viewport;
    if (view) {
      const target = scanWorld(series, focus.point);
      const camera = view.getCamera();
      if (camera.position && camera.focalPoint)
        view.setCamera({
          focalPoint: target,
          position: camera.position.map((n, i) => n + target[i]! - camera.focalPoint![i]!) as [
            number,
            number,
            number,
          ],
        });
      view.render();
    }
  }, [focus, ready, series, restore]);

  useEffect(() => {
    if (!restore || !ready || labelsPending) {
      setRestoring(false);
      if (!restore) setFrameRatio(undefined);
      return;
    }
    let cancelled = false;
    setRestoring(true);
    setSnapshotError(undefined);
    void (async () => {
      const state = restore.viewState;
      if (
        state.kind !== "acquired" ||
        state.seriesId !== series.id ||
        state.scanGeometrySha256 !== (await scanGeometryFingerprint(series)) ||
        state.sliceIndex >= series.slices.length
      )
        throw new Error("This snapshot does not match the open scan. Open its original series.");
      if (cancelled) return;
      setFrameRatio(state.viewport.width / state.viewport.height);
      await controls.current?.seek(state.sliceIndex);
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      if (cancelled) return;
      const view = controls.current?.viewport;
      if (!view || view.getCurrentImageIdIndex() !== state.sliceIndex)
        throw new Error("Could not load the saved slice. Try reopening the snapshot.");
      view.setCamera(state.camera);
      // CPU snapshots use a synthetic eye distance; GPU clipping must follow the restored camera.
      if (!getShouldUseCPURendering()) view.getRenderer().resetCameraClippingRange();
      view.setProperties({ voiRange: state.window });
      setWindow({
        width: String(state.window.upper - state.window.lower),
        center: String((state.window.upper + state.window.lower) / 2),
      });
      view.render();
    })()
      .catch((cause: Error) => {
        if (!cancelled) setSnapshotError(cause.message);
      })
      .finally(() => {
        if (!cancelled) setRestoring(false);
      });
    return () => {
      cancelled = true;
    };
  }, [restore, ready, labelsPending, series]);

  async function saveSnapshot() {
    if (!snapshots || !controls.current || !overlay.current || busy.current) return;
    busy.current = true;
    setSaving(true);
    setSnapshotError(undefined);
    try {
      if (pendingCapture.current?.scopeKey !== snapshots.scopeKey) pendingCapture.current = null;
      if (!pendingCapture.current) {
        const view = controls.current.viewport;
        drawLabels(
          overlay.current,
          view,
          series,
          view.getCurrentImageIdIndex(),
          layers,
          structures,
          display,
          focus,
          labels,
        );
        pendingCapture.current = {
          scopeKey: snapshots.scopeKey,
          capture: await captureAcquiredSnapshot(
            view,
            overlay.current,
            series,
            structures,
            display,
            labels,
            focus,
          ),
        };
      }
      // A failed save retries these exact pixels and UUID, never a newly selected slice.
      await snapshots.save(pendingCapture.current.capture);
      pendingCapture.current = null;
    } catch (cause) {
      setSnapshotError(
        cause instanceof TypeError
          ? "Could not save screenshot. Check your connection, then retry."
          : cause instanceof Error
            ? cause.message
            : "Could not save screenshot.",
      );
    } finally {
      busy.current = false;
      setSaving(false);
    }
  }

  useEffect(() => {
    const canvas = overlay.current;
    const host = element.current;
    if (!canvas || !host || !ready) return;
    const draw = () => {
      const view = controls.current?.viewport;
      if (view && !status)
        drawLabels(
          canvas,
          view,
          series,
          view.getCurrentImageIdIndex(),
          layers,
          structures,
          display,
          focus,
          labels,
        );
      else canvas.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
    };
    host.addEventListener(Enums.Events.IMAGE_RENDERED, draw);
    const resize = new ResizeObserver(draw);
    resize.observe(host);
    draw();
    return () => {
      resize.disconnect();
      host.removeEventListener(Enums.Events.IMAGE_RENDERED, draw);
    };
  }, [series, layers, structures, display, focus, labels, ready, status]);

  useEffect(() => {
    const host = element.current;
    if (!host) return;
    let disposed = false;
    let engine: RenderingEngine | undefined;
    let observer: ResizeObserver | undefined;
    let session: DicomSession | undefined;
    let desired = 0;
    let loading = false;
    setIndex(0);
    setReady(false);
    setError(false);
    setStatus("Preparing image viewer…");
    let pending = initializeDicom()
      .then(async () => {
        if (disposed) return;
        const activeSession = acquireDicomSession(series);
        session = activeSession;
        engine = new RenderingEngine(`local-${crypto.randomUUID()}`);
        engine.enableElement({ viewportId: "scan", type: Enums.ViewportType.STACK, element: host });
        const viewport = engine.getViewport("scan") as Types.IStackViewport;
        observer = new ResizeObserver(() => {
          if (host.clientWidth && host.clientHeight) engine?.resize(true, true);
        });
        observer.observe(host);
        await session.read(
          0,
          () => (disposed ? undefined : viewport.setStack(activeSession.imageIds)),
          true,
        );
        if (disposed) return;
        viewport.render();
        const voi = viewport.getProperties().voiRange;
        if (voi)
          setWindow({
            width: String(voi.upper - voi.lower),
            center: String((voi.upper + voi.lower) / 2),
          });
        controls.current = {
          viewport,
          seek(target) {
            desired = target;
            setIndex(target);
            if (loading) return pending;
            loading = true;
            setError(false);
            setStatus("Loading slice…");
            // One decode at a time; scrubbing coalesces to the latest requested slice.
            pending = (async () => {
              let loaded: number;
              do {
                loaded = desired;
                await activeSession.read(
                  loaded,
                  () => (disposed ? undefined : viewport.setImageIdIndex(loaded)),
                  true,
                );
                if (disposed) return;
              } while (loaded !== desired);
              viewport.render();
              setStatus("");
            })()
              .catch(showError)
              .finally(() => {
                loading = false;
              });
            return pending;
          },
        };
        setReady(true);
        setStatus("");
      })
      .catch(showError);

    function showError() {
      if (!disposed) {
        setError(true);
        setStatus(
          "This image could not be decoded or rendered. Try again, or export uncompressed DICOM.",
        );
      }
    }

    return () => {
      disposed = true;
      controls.current = null;
      observer?.disconnect();
      // The loader cannot cancel an active decode. Wait before destroying its viewport
      // and evict again afterwards so a late result cannot repopulate a closed scan.
      void pending.finally(() => {
        engine?.destroy();
        session?.release();
      });
    };
  }, [series, retry]);

  function changeWindow(width: string, center: string) {
    setWindow({ width, center });
    const w = Number(width);
    const c = Number(center);
    if (!width.trim() || !center.trim() || !Number.isFinite(w) || w < 1 || !Number.isFinite(c))
      return;
    controls.current?.viewport.setProperties({
      voiRange: { lower: c - w / 2, upper: c + w / 2 },
    });
    controls.current?.viewport.render();
  }

  return (
    <section className="dicom-stack" aria-label="DICOM slice viewer">
      <div className="dicom-canvas-wrap" style={{ containerType: "size" }}>
        <div
          className="dicom-snapshot-frame"
          style={
            frameRatio
              ? {
                  inset: "auto",
                  left: "50%",
                  top: "50%",
                  transform: "translate(-50%, -50%)",
                  width: `min(100cqw, calc(100cqh * ${frameRatio}))`,
                  height: `min(100cqh, calc(100cqw / ${frameRatio}))`,
                }
              : undefined
          }
        >
          <div
            ref={element}
            className="dicom-canvas"
            role="img"
            aria-label={`Acquired DICOM image, slice ${index + 1} of ${series.slices.length}`}
          />
          <canvas
            ref={overlay}
            className="dicom-label-overlay"
            aria-label="Segmentation labels and focused check region"
          />
          {status && (
            <div className="dicom-status" role={error ? "alert" : "status"}>
              <p>{status}</p>
              {error && (
                <button
                  type="button"
                  className="button mt-3"
                  onClick={() => setRetry((n) => n + 1)}
                >
                  Retry image
                </button>
              )}
            </div>
          )}
        </div>
      </div>
      <div className="slice-controls">
        <button
          type="button"
          className="icon-button"
          aria-label="Previous slice"
          disabled={!ready || index === 0}
          onClick={() => controls.current?.seek(index - 1)}
        >
          ←
        </button>
        <input
          type="range"
          aria-label="Slice"
          min={0}
          max={series.slices.length - 1}
          value={index}
          disabled={!ready}
          onChange={(event) => controls.current?.seek(Number(event.target.value))}
        />
        <output aria-live="polite">
          {index + 1} / {series.slices.length}
        </output>
        <button
          type="button"
          className="icon-button"
          aria-label="Next slice"
          disabled={!ready || index === series.slices.length - 1}
          onClick={() => controls.current?.seek(index + 1)}
        >
          →
        </button>
      </div>
      <fieldset className="image-controls" disabled={!ready || !!status}>
        <legend className="sr-only">Image display</legend>
        <label>
          Window
          <input
            aria-label="Window width"
            type="number"
            min={1}
            step="any"
            value={window.width}
            required
            onChange={(event) => changeWindow(event.target.value, window.center)}
          />
        </label>
        <label>
          Level
          <input
            aria-label="Window level"
            type="number"
            step="any"
            value={window.center}
            required
            onChange={(event) => changeWindow(window.width, event.target.value)}
          />
        </label>
        <ZoomControls
          label="Zoom"
          onZoom={(factor) => {
            const view = controls.current?.viewport;
            if (view) {
              view.setZoom(view.getZoom() * factor);
              view.render();
            }
          }}
        />
        <button
          type="button"
          className="text-button"
          onClick={() => {
            const view = controls.current?.viewport;
            if (!view) return;
            view.resetCamera();
            view.resetProperties();
            const voi = view.getProperties().voiRange;
            if (voi)
              setWindow({
                width: String(voi.upper - voi.lower),
                center: String((voi.upper + voi.lower) / 2),
              });
            view.render();
          }}
        >
          Reset view
        </button>
        {snapshots && (
          <button
            type="button"
            className="button"
            disabled={saving || restoring || labelsPending}
            onClick={() => void saveSnapshot()}
          >
            <Camera size={15} />
            {saving
              ? "Saving…"
              : pendingCapture.current?.scopeKey === snapshots.scopeKey
                ? "Retry save"
                : "Screenshot"}
          </button>
        )}
      </fieldset>
      {snapshotError && (
        <p role="alert" className="error-message px-3 pb-2">
          {snapshotError}
        </p>
      )}
    </section>
  );
}
