/** Load only selected/focused label files; terminate workers on replacement or close. */
import { useEffect, useRef, useState } from "react";
import type { DicomSeries } from "./dicom";
import { assertLabelGrid, type LabelSource, type LabelVolume } from "./labels";

export function useLabelVolumes(
  sources: LabelSource[],
  series: DicomSeries | undefined,
  revisionId?: string,
) {
  const key = `${revisionId}:${series?.id}`;
  const cache = useRef({ key, layers: new Map<string, LabelVolume>() });
  if (cache.current.key !== key) cache.current = { key, layers: new Map() };
  const [state, setState] = useState<{
    key: string;
    layers: LabelVolume[];
    error?: string;
    loading: boolean;
  }>({ key, layers: [], loading: false });
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!series) {
      setState({ key, layers: [], loading: false });
      return;
    }
    let stopped = false;
    const workers = new Set<Worker>();
    const local = cache.current.layers;
    for (const url of local.keys()) {
      if (!sources.some((s) => s.url === url)) local.delete(url);
    }
    const publish = (error?: string) => {
      if (stopped) return;
      const layers = sources.flatMap((s) => {
        const v = local.get(s.url);
        return v ? [v] : [];
      });
      setState({ key, layers, error, loading: !error && layers.length < sources.length });
    };
    publish();
    void (async () => {
      try {
        const total = sources.reduce(
          (sum, s) =>
            sum +
            s.volume.shapeZyx.reduce((a, b) => a * b, 1) *
              (s.volume.data?.format === "npy" && s.volume.data.dtype === "uint16" ? 2 : 1),
          0,
        );
        if (total > 1024 ** 3)
          throw new Error("Selected label volumes exceed the 1 GiB combined limit.");
        for (const source of sources) {
          assertLabelGrid(source.volume, series);
          if (local.has(source.url)) continue;
          const layer = await new Promise<LabelVolume>((resolve, reject) => {
            const worker = new Worker(new URL("./labels.worker.ts", import.meta.url), {
              type: "module",
            });
            workers.add(worker);
            worker.onmessage = ({
              data,
            }: MessageEvent<{ layer?: LabelVolume; error?: string }>) => {
              worker.terminate();
              workers.delete(worker);
              if (data.layer) resolve(data.layer);
              else reject(new Error(data.error ?? "Label worker failed."));
            };
            worker.onerror = () => {
              worker.terminate();
              workers.delete(worker);
              reject(new Error("Label worker stopped. Retry loading labels."));
            };
            worker.postMessage(source);
          });
          if (stopped) return;
          local.set(source.url, layer);
          publish();
        }
      } catch (error) {
        publish(error instanceof Error ? error.message : "Labels could not be loaded.");
      }
    })();
    return () => {
      stopped = true;
      for (const worker of workers) worker.terminate();
    };
  }, [sources, series, key, retry]);
  return {
    layers: state.key === key ? state.layers : [],
    error: state.key === key ? state.error : undefined,
    loading: state.key === key && state.loading,
    retry: () => setRetry((n) => n + 1),
  };
}
