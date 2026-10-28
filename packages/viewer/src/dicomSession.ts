/** Shared local-file registration and serial decoding for slices and the bounded volume preview. */
import { cache, init, type Types } from "@cornerstonejs/core";
import { init as initDicom, wadouri } from "@cornerstonejs/dicom-image-loader";
import type { DicomSeries } from "./dicom";

/** Cornerstone cache budget for decoded source slices; a 3D volume is admitted on top. */
export const sliceCacheBytes = 256 * 1024 * 1024;

let initialization: Promise<void> | undefined;
export function initializeDicom() {
  initialization ??= (async () => {
    await init();
    cache.setMaxCacheSize(sliceCacheBytes);
    initDicom({ maxWebWorkers: 2 });
  })();
  return initialization;
}

const sessions = new WeakMap<DicomSeries, DicomSession>();
export function acquireDicomSession(series: DicomSeries) {
  let session = sessions.get(series);
  if (!session) {
    session = new DicomSession(series);
    sessions.set(series, session);
  }
  session.references++;
  return session;
}

class DicomSession {
  readonly imageIds: string[];
  references = 0;
  private pending: Promise<unknown> = Promise.resolve();
  private displayed?: string;

  constructor(private series: DicomSeries) {
    this.imageIds = series.slices.map((slice) => wadouri.fileManager.add(slice.file));
  }

  read<T>(index: number, consume: (image: Types.IImage) => T | Promise<T>, keep = false) {
    const id = this.imageIds[index] as string;
    const task = this.pending.then(async () => {
      try {
        if (!cache.isLoaded(id)) {
          // Await insertion: GPU setStack can resolve even on decode failure.
          const load = wadouri.loadImage(id);
          load.promise = load.promise.then((image) => {
            image.sharedCacheKey = undefined;
            return image;
          });
          await cache.putImageLoadObject(id, load);
        }
        const result = await consume(cache.getImage(id) as Types.IImage);
        if (keep) {
          const old = this.displayed;
          this.displayed = id;
          if (old && old !== id) this.evict(old);
        }
        return result;
      } finally {
        // The preview copies one slice at a time, never retaining a second decoded volume.
        if (id !== this.displayed) this.evict(id);
      }
    });
    this.pending = task.catch(() => {});
    return task;
  }

  private evict(id: string) {
    if (cache.getImageLoadObject(id)) cache.removeImageLoadObject(id);
    const parsed = wadouri.parseImageId(id);
    // Failed decodes can leave a parsed dataset without a cached image.
    if (wadouri.dataSetCacheManager.isLoaded(parsed.url))
      wadouri.dataSetCacheManager.unload(parsed.url);
  }

  release() {
    if (--this.references) return;
    sessions.delete(this.series);
    void this.pending.then(() => {
      for (const id of this.imageIds) {
        this.evict(id);
        wadouri.fileManager.remove(Number(wadouri.parseImageId(id).url));
      }
    });
  }
}

export type { DicomSession };
