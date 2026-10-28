/** Acquired-slice viewport. Cornerstone owns pixel decoding, modality/VOI transforms and pixel aspect ratio. */
import { Enums, RenderingEngine, type Types } from "@cornerstonejs/core";
import { useEffect, useRef, useState } from "react";
import type { DicomSeries } from "./dicom";
import { acquireDicomSession, type DicomSession, initializeDicom } from "./dicomSession";

export default function DicomStack({ series }: { series: DicomSeries }) {
  const element = useRef<HTMLDivElement>(null);
  const controls = useRef<{
    viewport: Types.IStackViewport;
    seek(index: number): void;
  } | null>(null);
  const [index, setIndex] = useState(0);
  const [status, setStatus] = useState("Preparing image viewer…");
  const [error, setError] = useState(false);
  const [ready, setReady] = useState(false);
  const [window, setWindow] = useState({ width: "1", center: "0" });
  const [retry, setRetry] = useState(0);

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
            if (loading) return;
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
      <div className="dicom-canvas-wrap">
        <div
          ref={element}
          className="dicom-canvas"
          role="img"
          aria-label={`Acquired DICOM image, slice ${index + 1} of ${series.slices.length}`}
        />
        {status && (
          <div className="dicom-status" role={error ? "alert" : "status"}>
            <p>{status}</p>
            {error && (
              <button type="button" className="button mt-3" onClick={() => setRetry((n) => n + 1)}>
                Retry image
              </button>
            )}
          </div>
        )}
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
        <button
          type="button"
          className="icon-button"
          aria-label="Zoom out"
          onClick={() => {
            const view = controls.current?.viewport;
            if (view) {
              view.setZoom(view.getZoom() / 1.2);
              view.render();
            }
          }}
        >
          −
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label="Zoom in"
          onClick={() => {
            const view = controls.current?.viewport;
            if (view) {
              view.setZoom(view.getZoom() * 1.2);
              view.render();
            }
          }}
        >
          +
        </button>
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
      </fieldset>
    </section>
  );
}
