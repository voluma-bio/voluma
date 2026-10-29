/** Automatic full-resolution raw volume display. No meshes or analysis results. */
import {
  cache,
  Enums,
  RenderingEngine,
  type Types,
  utilities,
  type VolumeViewport3D,
  volumeLoader,
} from "@cornerstonejs/core";
import type { Focus } from "@voluma/contracts/review";
import { useEffect, useMemo, useRef, useState } from "react";
import type { DicomSeries } from "./dicom";
import {
  acquireDicomSession,
  type DicomSession,
  initializeDicom,
  sliceCacheBytes,
} from "./dicomSession";
import { scanWorld } from "./labels";
import { planVolume, sampleVolume, type VolumePlan } from "./volume";
import { ZoomControls } from "./ZoomControls";

// One volume slot. Serialize replacement so two volume buffers/textures never
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
    return `Full-resolution 3D exceeds this browser's limit of ${limit} voxels per axis. Acquired slices remain available.`;
  if (textureBytes(plan) > maxTextureBytes)
    return "Full-resolution 3D needs more than 2 GiB of graphics memory. Acquired slices remain available.";
}

export default function DicomVolume({ series, focus }: { series: DicomSeries; focus?: Focus }) {
  const plan = useMemo(() => {
    try {
      const planned = planVolume(series);
      return admission(planned) ?? planned;
    } catch (error) {
      return (error as Error).message;
    }
  }, [series]);
  return (
    <section className="dicom-stack" aria-label="3D volume">
      {typeof plan === "string" ? (
        <div className="view-empty" role="alert">
          {plan}
        </div>
      ) : (
        <VolumeView series={series} plan={plan} focus={focus} />
      )}
    </section>
  );
}

function VolumeView({
  series,
  plan,
  focus,
}: {
  series: DicomSeries;
  plan: VolumePlan;
  focus?: Focus;
}) {
  const element = useRef<HTMLDivElement>(null);
  const outline = useRef<HTMLCanvasElement>(null);
  const controls = useRef<{
    view: VolumeViewport3D;
    rotate(x: number, y: number): void;
    dragging(on: boolean): void;
    display(threshold: number, opacity: number): void;
    reset(): void;
  } | null>(null);
  const pointer = useRef<{ id: number; x: number; y: number; moved: boolean } | null>(null);
  const [status, setStatus] = useState("Preparing 3D…");
  const [error, setError] = useState(false);
  const [ready, setReady] = useState(false);
  const [threshold, setThreshold] = useState(20);
  const [opacity, setOpacity] = useState(35);

  useEffect(() => {
    const view = controls.current?.view;
    if (!ready || !view || !focus?.point) return;
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
  }, [series, focus, ready]);

  useEffect(() => {
    const host = element.current;
    const canvas = outline.current;
    if (!host || !canvas || !ready) return;
    const draw = () => {
      canvas.width = Math.round(host.clientWidth * devicePixelRatio);
      canvas.height = Math.round(host.clientHeight * devicePixelRatio);
      const ctx = canvas.getContext("2d")!;
      const view = controls.current?.view;
      if (!view || !focus?.point) return;
      ctx.scale(devicePixelRatio, devicePixelRatio);
      ctx.strokeStyle = getComputedStyle(canvas).getPropertyValue("--check-outline").trim();
      ctx.lineWidth = 2;
      ctx.beginPath();
      if (focus.box) {
        const corners = Array.from({ length: 8 }, (_, bits) =>
          view.worldToCanvas(
            scanWorld(
              series,
              focus.box!.min.map((n, a) => (bits & (1 << a) ? focus.box!.max[a]! : n)),
            ),
          ),
        );
        for (let i = 0; i < 8; i++)
          for (let a = 0; a < 3; a++) {
            if (i & (1 << a)) continue;
            const from = corners[i]!;
            const to = corners[i | (1 << a)]!;
            ctx.moveTo(from[0], from[1]);
            ctx.lineTo(to[0], to[1]);
          }
      } else {
        const p = view.worldToCanvas(scanWorld(series, focus.point));
        ctx.moveTo(p[0] - 8, p[1]);
        ctx.lineTo(p[0] + 8, p[1]);
        ctx.moveTo(p[0], p[1] - 8);
        ctx.lineTo(p[0], p[1] + 8);
      }
      ctx.stroke();
    };
    host.addEventListener(Enums.Events.IMAGE_RENDERED, draw);
    const observer = new ResizeObserver(draw);
    observer.observe(host);
    draw();
    return () => {
      observer.disconnect();
      host.removeEventListener(Enums.Events.IMAGE_RENDERED, draw);
    };
  }, [series, focus, ready]);

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
    const pending = (async () => {
      await previous;
      signal.throwIfAborted();
      // A failed retirement must never make createLocalVolume reuse an old scan.
      if (cache.getVolume(volumeId)) throw new Error("Previous volume was not released");
      await initializeDicom();
      signal.throwIfAborted();
      session = acquireDicomSession(series);
      const sampled = await sampleVolume(session, plan, signal, (done) => {
        if (!signal.aborted) setStatus(`Building 3D ${done} / ${plan.dimensions[2]}…`);
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
      // Local volumes start with no dirty frames in Cornerstone 4.22; mark
      // every populated slice for GPU upload before the first render.
      volume.invalidate();
      // Default VOI otherwise tries to load a synthetic local-image ID as DICOM.
      utilities.genericMetadataProvider.add(
        volume.imageIds[Math.floor(volume.imageIds.length / 2)] as string,
        {
          type: "voiLutModule",
          metadata: { windowCenter: [(min + max) / 2], windowWidth: [max - min] },
        },
      );
      // Another pane may be maximized. Cornerstone cannot render a zero-size host.
      await waitForViewport(host, signal);
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
          setStatus("The 3D graphics context was lost. Close and reopen the scan to retry.");
        },
        { signal },
      );
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
      };
      observer = new ResizeObserver(() => {
        if (host.clientWidth && host.clientHeight) engine?.resize(true, true);
      });
      observer.observe(host);
      setStatus("Rendering 3D…");
      await renderFrame(host, signal, () => view.render());
      signal.throwIfAborted();
      setStatus("");
      setReady(true);
    })().catch(() => {
      if (!signal.aborted) {
        setError(true);
        setStatus(
          "3D could not be loaded. Close and reopen the scan to retry. Acquired slices remain available.",
        );
      }
    });
    return () => {
      abort.abort();
      controls.current = null;
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
            if (!ready || e.button !== 0) return;
            e.currentTarget.setPointerCapture(e.pointerId);
            pointer.current = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false };
          }}
          onPointerMove={(e) => {
            const p = pointer.current;
            if (!p) return;
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
            if (!ready || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key))
              return;
            e.preventDefault();
            controls.current?.rotate(
              e.key === "ArrowLeft" ? -10 : e.key === "ArrowRight" ? 10 : 0,
              e.key === "ArrowUp" ? -10 : e.key === "ArrowDown" ? 10 : 0,
            );
          }}
        />
        <canvas
          ref={outline}
          className="dicom-label-overlay"
          aria-label="Focused check region in 3D"
        />
        {status && (
          <div className="dicom-status" role={error ? "alert" : "status"}>
            <p>{status}</p>
          </div>
        )}
      </div>
      <fieldset className="image-controls" disabled={!ready}>
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
        <ZoomControls
          label="3D zoom"
          onZoom={(factor) => {
            const view = controls.current?.view;
            if (view) {
              view.setZoom(view.getZoom() * factor);
              view.render();
            }
          }}
        />
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
    </>
  );
}

function waitForViewport(host: HTMLElement, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      observer.disconnect();
      signal.removeEventListener("abort", aborted);
    };
    const aborted = () => {
      cleanup();
      reject(new Error("Render cancelled"));
    };
    const checkSize = () => {
      if (signal.aborted) aborted();
      else if (host.clientWidth && host.clientHeight) {
        cleanup();
        resolve();
      }
    };
    const observer = new ResizeObserver(checkSize);
    observer.observe(host);
    signal.addEventListener("abort", aborted, { once: true });
    checkSize();
  });
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
