/** Local DICOM intake contract. Blobs live only for the open workspace; no uploads or persistence. */
export type Point3 = [number, number, number];
export type Orientation = [number, number, number, number, number, number];
export interface DicomSlice {
  file: Blob;
  position: Point3;
  frameOfReferenceUID?: string;
  /** Stored pixel format and linear modality rescale, used to choose native 3D storage. */
  stored: { bits: number; signed: boolean; slope: number; intercept: number };
}

export interface DicomSeries {
  id: string;
  modality: string;
  rows: number;
  columns: number;
  /** DICOM row/column spacing in millimetres, not calibrated mineral density. */
  spacing: number[];
  orientation: Orientation;
  slices: DicomSlice[];
}

export interface DicomArchive {
  series: DicomSeries[];
  ignoredFiles: number;
}

export type IntakeMessage =
  | { type: "progress"; done: number; total: number }
  | { type: "ready"; archive: DicomArchive }
  | { type: "error"; message: string };

export function openDicomZip(
  file: File,
  signal: AbortSignal,
  onProgress: (done: number, total: number) => void,
): Promise<DicomArchive> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    if (!file.name.toLowerCase().endsWith(".zip")) {
      reject(new Error("Choose a ZIP of DICOM files. Single DCM files are not supported yet."));
      return;
    }
    const worker = new Worker(new URL("./dicom.worker.ts", import.meta.url), { type: "module" });
    const stop = () => {
      worker.terminate();
      signal.removeEventListener("abort", abort);
    };
    const abort = () => {
      stop();
      reject(new DOMException("Import cancelled", "AbortError"));
    };
    signal.addEventListener("abort", abort, { once: true });
    worker.onmessage = ({ data }: MessageEvent<IntakeMessage>) => {
      if (data.type === "progress") onProgress(data.done, data.total);
      else {
        stop();
        if (data.type === "ready") resolve(data.archive);
        else reject(new Error(data.message));
      }
    };
    worker.onerror = () => {
      stop();
      reject(new Error("The DICOM import worker stopped. Try a smaller ZIP or reload the page."));
    };
    worker.postMessage(file);
  });
}
