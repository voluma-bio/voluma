/** On-demand raw volume display and local performance measurements. No meshes or analysis results. */
import {
  cache,
  Enums,
  RenderingEngine,
  type Types,
  utilities,
  type VolumeViewport3D,
  volumeLoader,
} from "@cornerstonejs/core";
import { useEffect, useMemo, useRef, useState } from "react";
import type { DicomSeries } from "./dicom";
import {
  acquireDicomSession,
  type DicomSession,
  initializeDicom,
  sliceCacheBytes,
} from "./dicomSession";
import { planVolume, sampleVolume, type VolumePlan, type VolumeSize } from "./volume";

// One preview slot. Serialize replacement so two preview buffers/textures never
// coexist. Reuse IDs: 4.22's local-image metadata provider has no per-ID removal.
const volumeId = "voluma-local-preview";
let retired: Promise<void> = Promise.resolve();
// Admission ceiling for one volume's estimated GPU texture.
const maxTextureBytes = 2 * 1024 * 1024 * 1024;

let textureLimit: number | undefined;
/** Largest 3D texture edge this browser's WebGL2 allows, or 0 without WebGL2. */
function maxTextureSize() {
  if (textureLimit === undefined) {
    const gl = document.createElement("canvas").getContext("webgl2");
    textureLimit = gl ? (gl.getParameter(gl.MAX_3D_TEXTURE_SIZE) as number) : 0;
    gl?.getExtension("WEBGL_lose_context")?.loseContext();
  }
  return textureLimit;
}

/**
 * GPU texture bytes. Cornerstone 4.22 disables half float, so 16-bit voxels
 * become R32F unless norm16 is usable, which core doesn't expose: assume 4 bytes.
 */
function textureBytes(plan: VolumePlan) {
  return (plan.bytes / plan.ArrayType.BYTES_PER_ELEMENT) * (plan.ArrayType === Uint8Array ? 1 : 4);
}

function admission(plan: VolumePlan) {
  const limit = maxTextureSize();
  if (!limit) return "3D needs WebGL2, which this browser doesn't provide.";
  if (plan.dimensions.some((n) => n > limit))
    return `This browser's graphics limit is ${limit} voxels per axis. Choose a preview size.`;
  if (textureBytes(plan) > maxTextureBytes)
    return "This volume needs more than 2 GiB of graphics memory. Choose a preview size.";
}

export default function DicomVolume({ series }: { series: DicomSeries }) {
  const [size, setSize] = useState<VolumeSize>("full");
  const [open, setOpen] = useState(false);
  const plan = useMemo(() => {
    try {
      return planVolume(series, size);
    } catch (error) {
      return (error as Error).message;
    }
  }, [series, size]);
  const refused = typeof plan === "string" ? undefined : admission(plan);
  return (
    <section className="dicom-stack" aria-label="Raw volume preview">
      {typeof plan === "string" ? (
        <div className="view-empty" role="status">
          {plan}
        </div>
      ) : open ? (
        <VolumeView series={series} plan={plan} onClose={() => setOpen(false)} />
      ) : (
        <>
          <div className="view-empty">
            <p>Raw intensities, not segmented anatomy.</p>
            <label className="volume-quality">
              3D resolution
              <select
                aria-label="3D resolution"
                value={size}
                onChange={(e) =>
                  setSize(
                    e.target.value === "full" ? "full" : (Number(e.target.value) as 128 | 256),
                  )
                }
              >
                <option value="full">Full resolution · every acquired voxel</option>
                <option value={256}>Standard preview · up to 256 per axis</option>
                <option value={128}>Compact preview · up to 128 per axis</option>
              </select>
            </label>
            <p className="text-xs">
              {plan.downsampled ? "Downsampled" : "Native grid"} · {plan.dimensions.join(" × ")} ·{" "}
              {(plan.bytes / 1048576).toFixed(1)} MiB voxels
              {plan.stored ? ` · ${plan.ArrayType.BYTES_PER_ELEMENT * 8}-bit stored values` : ""}
              {textureBytes(plan) > plan.bytes
                ? ` · up to ${(textureBytes(plan) / 1048576).toFixed(0)} MiB on the graphics card`
                : ""}
            </p>
            {refused && (
              <p className="text-xs" role="alert">
                {refused}
              </p>
            )}
            <button
              className="button mt-3"
              type="button"
              disabled={!!refused}
              onClick={() => setOpen(true)}
            >
              Build 3D
            </button>
          </div>
          <p className="volume-note">
            {plan.downsampled
              ? "3D is display only. Small structures may disappear at preview resolution."
              : "3D is display only. Every acquired voxel is kept."}
          </p>
        </>
      )}
    </section>
  );
}

type Rotation = { frames: number; p50Ms: number; p95Ms: number; fps: number; canvas: number[] };
type PerformanceReport = {
  source: number[];
  preview: number[];
  spacingMm: number[];
  downsampled: boolean;
  voxelBytes: number;
  voxelType: string;
  firstVisibleMs?: number;
  preparationMs?: number;
  sampledPeakJsHeapBytes?: number;
  peakCacheBytes: number;
  rotation?: Rotation;
  /** Same rotation at the coarser ray sampling used while dragging. */
  dragRotation?: Rotation;
  userAgent: string;
  devicePixelRatio: number;
  renderer: string;
  note: string;
};

function VolumeView({
  series,
  plan,
  onClose,
}: {
  series: DicomSeries;
  plan: VolumePlan;
  onClose(): void;
}) {
  const element = useRef<HTMLDivElement>(null);
  const controls = useRef<{
    view: VolumeViewport3D;
    rotate(x: number, y: number): void;
    dragging(on: boolean): void;
    display(threshold: number, opacity: number): void;
    measure(): Promise<void>;
    reset(): void;
  } | null>(null);
  const pointer = useRef<{ id: number; x: number; y: number; moved: boolean } | null>(null);
  const [status, setStatus] = useState("Preparing 3D…");
  const [error, setError] = useState(false);
  const [ready, setReady] = useState(false);
  const [threshold, setThreshold] = useState(20);
  const [opacity, setOpacity] = useState(35);
  const [measuring, setMeasuring] = useState(false);
  const [measurementError, setMeasurementError] = useState("");
  const report = useRef<PerformanceReport | null>(null);
  const [metrics, setMetrics] = useState<PerformanceReport | null>(null);

  useEffect(() => {
    const host = element.current;
    if (!host) return;
    const abort = new AbortController();
    const signal = abort.signal;
    let session: DicomSession | undefined;
    let engine: RenderingEngine | undefined;
    let observer: ResizeObserver | undefined;
    let volume: Types.IImageVolume | undefined;
    let finishRetirement: () => void;
    const previous = retired;
    retired = new Promise<void>((resolve) => {
      finishRetirement = resolve;
    });
    const started = performance.now();
    const data: PerformanceReport = {
      source: plan.source,
      preview: plan.dimensions,
      spacingMm: plan.spacing,
      downsampled: plan.downsampled,
      voxelBytes: plan.bytes,
      voxelType: plan.ArrayType.name,
      peakCacheBytes: 0,
      userAgent: navigator.userAgent,
      devicePixelRatio,
      renderer: "Unavailable",
      note: "Local display benchmark; no scan identifiers. First visible starts at Build, excludes ZIP intake. Rotation is sequential render latency, not GPU timer or clinical validation. JS heap is sampled every 100 ms, not process/GPU memory; peaks may be missed.",
    };
    report.current = data;
    const sampleMemory = () => {
      const memory = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
      if (memory)
        data.sampledPeakJsHeapBytes = Math.max(
          data.sampledPeakJsHeapBytes ?? 0,
          memory.usedJSHeapSize,
        );
      data.peakCacheBytes = Math.max(data.peakCacheBytes, cache.getCacheSize());
    };
    let timer = window.setInterval(sampleMemory, 100);
    const pending = (async () => {
      await previous;
      signal.throwIfAborted();
      // A failed retirement must never make createLocalVolume reuse an old scan.
      if (cache.getVolume(volumeId)) throw new Error("Previous preview was not released");
      await initializeDicom();
      signal.throwIfAborted();
      session = acquireDicomSession(series);
      const sampled = await sampleVolume(session, plan, signal, (done) => {
        if (!signal.aborted) setStatus(`Building 3D ${done} / ${plan.dimensions[2]}…`);
        sampleMemory();
      });
      signal.throwIfAborted();
      const { min, max, scalarData } = sampled;
      // Admit this volume's bytes explicitly; slices keep their own budget.
      cache.setMaxCacheSize(sliceCacheBytes + plan.bytes);
      volume = volumeLoader.createLocalVolume(volumeId, {
        dimensions: plan.dimensions,
        spacing: plan.spacing,
        origin: plan.origin,
        direction: plan.direction,
        scalarData,
        metadata: {
          BitsAllocated: plan.ArrayType.BYTES_PER_ELEMENT * 8,
          BitsStored: plan.ArrayType.BYTES_PER_ELEMENT * 8,
          HighBit: plan.ArrayType.BYTES_PER_ELEMENT * 8 - 1,
          SamplesPerPixel: 1,
          PhotometricInterpretation: "MONOCHROME2",
          PixelRepresentation:
            plan.ArrayType === Uint8Array || plan.ArrayType === Uint16Array ? 0 : 1,
          Modality: series.modality,
          ImageOrientationPatient: series.orientation,
          PixelSpacing: [plan.spacing[1], plan.spacing[0]],
          FrameOfReferenceUID: volumeId,
          Columns: plan.dimensions[0],
          Rows: plan.dimensions[1],
          voiLut: [{ windowCenter: (min + max) / 2, windowWidth: max - min }],
          VOILUTFunction: "LINEAR",
        },
      });
      // Default VOI otherwise tries to load a synthetic local-image ID as DICOM.
      utilities.genericMetadataProvider.add(
        volume.imageIds[Math.floor(volume.imageIds.length / 2)] as string,
        {
          type: "voiLutModule",
          metadata: { windowCenter: [(min + max) / 2], windowWidth: [max - min] },
        },
      );
      engine = new RenderingEngine(`volume-${crypto.randomUUID()}`);
      engine.enableElement({
        viewportId: "volume",
        type: Enums.ViewportType.VOLUME_3D,
        element: host,
      });
      const view = engine.getViewport("volume") as VolumeViewport3D;
      await view.setVolumes([
        {
          volumeId,
          callback: ({ volumeActor }) => {
            volumeActor.getProperty().setScalarOpacityUnitDistance(0, Math.min(...plan.spacing));
            volumeActor.getProperty().setShade(false);
          },
        },
      ]);
      signal.throwIfAborted();
      const gl = engine
        .getOffscreenMultiRenderWindow("volume")
        .getOpenGLRenderWindow()
        .get3DContext();
      gl.canvas.addEventListener(
        "webglcontextlost",
        () => {
          controls.current = null;
          setReady(false);
          setError(true);
          setStatus("The 3D graphics context was lost. Release 3D and rebuild the preview.");
        },
        { signal },
      );
      const debug = gl.getExtension("WEBGL_debug_renderer_info");
      data.renderer = debug
        ? String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL))
        : String(gl.getParameter(gl.RENDERER));
      const display = (cut: number, alpha: number) => {
        const low = min + ((max - min) * cut) / 100;
        view.setProperties({
          voiRange: { lower: low, upper: max },
          colormap: {
            name: "Grayscale",
            opacity: [
              { value: min, opacity: 0 },
              { value: Math.max(min + (max - min) * 0.0001, low), opacity: 0 },
              { value: max, opacity: alpha / 100 },
            ],
          },
        });
        view.render();
      };
      const rotate = (x: number, y: number) => {
        const camera = view.getRenderer().getActiveCamera();
        camera.azimuth(x);
        camera.elevation(y);
        camera.orthogonalizeViewUp();
        view.setCamera({ position: camera.getPosition(), viewUp: camera.getViewUp() });
      };
      display(20, 35);
      view.resetCamera();
      rotate(25, -15);
      const home = view.getCamera();
      controls.current = {
        view,
        rotate,
        display,
        reset() {
          view.setCamera(home);
          display(20, 35);
        },
        // Native grids take more ray samples per pixel; halve them while dragging
        // and restore full sampling when the pointer is released.
        dragging(on) {
          view.setSampleDistanceMultiplier(on ? 2 : 1);
        },
        async measure() {
          const camera = view.getCamera();
          timer = window.setInterval(sampleMemory, 100);
          const sweep = async (): Promise<Rotation> => {
            const times: number[] = [];
            for (let i = 0; i < 24; i++) {
              signal.throwIfAborted();
              const start = performance.now();
              await renderFrame(host, signal, () => rotate(15, 0));
              times.push(performance.now() - start);
              sampleMemory();
            }
            times.sort((a, b) => a - b);
            return {
              frames: times.length,
              p50Ms: times[11] as number,
              p95Ms: times[22] as number,
              fps: (1000 * times.length) / times.reduce((a, b) => a + b, 0),
              canvas: [view.canvas.width, view.canvas.height],
            };
          };
          try {
            data.rotation = await sweep();
            view.setSampleDistanceMultiplier(2);
            data.dragRotation = await sweep();
            setMetrics({ ...data });
          } finally {
            window.clearInterval(timer);
            if (!signal.aborted) {
              view.setSampleDistanceMultiplier(1);
              view.setCamera(camera);
            }
          }
        },
      };
      observer = new ResizeObserver(() => {
        if (host.clientWidth && host.clientHeight) engine?.resize(true, true);
      });
      observer.observe(host);
      data.preparationMs = performance.now() - started;
      setStatus("Rendering 3D…");
      await renderFrame(host, signal, () => view.render());
      signal.throwIfAborted();
      data.firstVisibleMs = performance.now() - started;
      sampleMemory();
      setMetrics({ ...data });
      setStatus("");
      setReady(true);
    })()
      .catch(() => {
        if (!signal.aborted) {
          setError(true);
          setStatus(
            "3D could not be built or rendered. Release it and choose a smaller preview size, or reload the page. Acquired slices remain available. WebGL2 is required.",
          );
        }
      })
      .finally(() => window.clearInterval(timer));
    return () => {
      abort.abort();
      controls.current = null;
      window.clearInterval(timer);
      observer?.disconnect();
      void pending.finally(() => {
        try {
          engine?.destroy();
          // Cache removal alone doesn't release the volume's GL texture in 4.22.
          if (cache.getVolume(volumeId) === volume && volume)
            cache.removeVolumeLoadObject(volumeId);
          volume?.destroy();
          // Also remove partially created local images if volume creation failed.
          for (let i = 0; i < plan.dimensions[2]; i++) {
            const id = `${volumeId}_slice_${i}`;
            if (cache.getImageLoadObject(id)) cache.removeImageLoadObject(id);
          }
          session?.release();
        } finally {
          if (!cache.getVolume(volumeId)) cache.setMaxCacheSize(sliceCacheBytes);
          finishRetirement();
        }
      });
    };
  }, [series, plan]);

  return (
    <>
      <div className="dicom-canvas-wrap">
        <div
          ref={element}
          className="dicom-canvas volume-canvas"
          role="application"
          // biome-ignore lint/a11y/noNoninteractiveTabindex: the canvas accepts arrow-key camera rotation.
          tabIndex={0}
          aria-label="Raw 3D volume. Drag or use arrow keys to rotate."
          onPointerDown={(e) => {
            if (!ready || measuring || e.button !== 0) return;
            e.currentTarget.setPointerCapture(e.pointerId);
            pointer.current = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false };
          }}
          onPointerMove={(e) => {
            const p = pointer.current;
            if (!p || measuring) return;
            // Coarse sampling only once the pointer actually drags, not on a click.
            if (!p.moved) controls.current?.dragging(true);
            controls.current?.rotate((e.clientX - p.x) * 0.5, (e.clientY - p.y) * 0.5);
            pointer.current = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: true };
          }}
          onPointerUp={() => {
            if (pointer.current?.moved) controls.current?.dragging(false);
            pointer.current = null;
          }}
          onLostPointerCapture={() => {
            if (pointer.current?.moved) controls.current?.dragging(false);
            pointer.current = null;
          }}
          onKeyDown={(e) => {
            if (
              !ready ||
              measuring ||
              !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)
            )
              return;
            e.preventDefault();
            controls.current?.rotate(
              e.key === "ArrowLeft" ? -10 : e.key === "ArrowRight" ? 10 : 0,
              e.key === "ArrowUp" ? -10 : e.key === "ArrowDown" ? 10 : 0,
            );
          }}
        />
        {status && (
          <div className="dicom-status" role={error ? "alert" : "status"}>
            <p>{status}</p>
          </div>
        )}
      </div>
      <p className="volume-note">
        {plan.downsampled ? "Downsampled" : "Native grid"} · {plan.dimensions.join(" × ")} · Raw
        volume, not segmented surfaces
      </p>
      <fieldset className="image-controls" disabled={!ready || measuring}>
        <legend className="sr-only">Volume display</legend>
        <label>
          Intensity cutoff
          <input
            aria-label="3D intensity cutoff"
            type="range"
            min={0}
            max={95}
            value={threshold}
            onChange={(e) => {
              const n = Number(e.target.value);
              setThreshold(n);
              controls.current?.display(n, opacity);
            }}
          />
        </label>
        <label>
          Opacity
          <input
            aria-label="3D opacity"
            type="range"
            min={0}
            max={100}
            value={opacity}
            onChange={(e) => {
              const n = Number(e.target.value);
              setOpacity(n);
              controls.current?.display(threshold, n);
            }}
          />
        </label>
        <button
          className="icon-button"
          type="button"
          aria-label="3D zoom out"
          onClick={() => {
            const v = controls.current?.view;
            if (v) {
              v.setZoom(v.getZoom() / 1.2);
              v.render();
            }
          }}
        >
          −
        </button>
        <button
          className="icon-button"
          type="button"
          aria-label="3D zoom in"
          onClick={() => {
            const v = controls.current?.view;
            if (v) {
              v.setZoom(v.getZoom() * 1.2);
              v.render();
            }
          }}
        >
          +
        </button>
        <button
          className="text-button"
          type="button"
          onClick={() => {
            controls.current?.reset();
            setThreshold(20);
            setOpacity(35);
          }}
        >
          Reset 3D
        </button>
      </fieldset>
      <div className="volume-actions">
        <button className="text-button" type="button" onClick={onClose}>
          {ready || error ? "Release 3D" : "Cancel 3D"}
        </button>
        <details>
          <summary>
            Performance
            {metrics?.firstVisibleMs !== undefined
              ? ` · ${(metrics.firstVisibleMs / 1000).toFixed(1)} s to 3D`
              : ""}
          </summary>
          <p>{(plan.bytes / 1048576).toFixed(1)} MiB voxels. GPU/process memory not measured.</p>
          <button
            className="text-button"
            type="button"
            disabled={!ready || measuring}
            onClick={async () => {
              setMeasuring(true);
              setMeasurementError("");
              try {
                await controls.current?.measure();
              } catch {
                setMeasurementError(
                  "Rotation measurement stopped. Keep the preview visible and try again.",
                );
              } finally {
                setMeasuring(false);
              }
            }}
          >
            {measuring ? "Measuring…" : "Measure rotation"}
          </button>
          {metrics?.rotation && (
            <p>
              {metrics.rotation.fps.toFixed(1)} frames/s · p95 {metrics.rotation.p95Ms.toFixed(0)}{" "}
              ms · {metrics.rotation.canvas.join(" × ")} px
              {metrics.dragRotation &&
                ` · dragging ${metrics.dragRotation.fps.toFixed(1)} frames/s, p95 ${metrics.dragRotation.p95Ms.toFixed(0)} ms`}
            </p>
          )}
          {measurementError && <p role="status">{measurementError}</p>}
          <button
            className="text-button"
            type="button"
            disabled={!ready || measuring}
            onClick={() => {
              const url = URL.createObjectURL(
                new Blob([JSON.stringify(report.current, null, 2)], { type: "application/json" }),
              );
              const link = document.createElement("a");
              link.href = url;
              link.download = "voluma-3d-performance.json";
              link.click();
              setTimeout(() => URL.revokeObjectURL(url), 1000);
            }}
          >
            Save timings
          </button>
        </details>
      </div>
    </>
  );
}

function renderFrame(host: HTMLElement, signal: AbortSignal, render: () => void) {
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", aborted);
      host.removeEventListener(Enums.Events.IMAGE_RENDERED, done);
    };
    const done = () => {
      cleanup();
      resolve();
    };
    const aborted = () => {
      cleanup();
      reject(new Error("Render cancelled"));
    };
    const timer = setTimeout(aborted, 10000);
    host.addEventListener(Enums.Events.IMAGE_RENDERED, done, { once: true });
    signal.addEventListener("abort", aborted, { once: true });
    try {
      signal.throwIfAborted();
      render();
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}
