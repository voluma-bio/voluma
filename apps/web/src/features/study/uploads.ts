/**
 * The uploads behind Run on new scans: each dropped scan becomes an input
 * (`@voluma/contracts/run`, Uploads) while the researcher fills in the rest of the page.
 * Scans upload one at a time, so a study of many stays under the server's open-upload limit
 * (`UPLOAD_MAX_OPEN`, 3); a scan's files PUT straight to storage, 4 at once, 3 tries each,
 * then complete. A scan with files that didn't upload waits for Retry, which sends only
 * those; one whose complete failed retries the complete. Removing a scan aborts and cancels
 * its upload. Leaving the page aborts them all; a reload asks first, and a deploy's reload waits
 * for them (`holdLeave`).
 *
 * Bytes sent live outside React state (`Progress`), read per scan with `useSent`: progress
 * arrives every frame, and page state changing at frame rate re-renders the whole page.
 */
import { useQueryClient } from "@tanstack/react-query";
import {
  ApiError,
  cancelUpload,
  completeUpload,
  createUpload,
  putUploadFile,
  UploadIncompleteError,
} from "@voluma/api-client";
import { inputsQuery } from "@voluma/api-client/query";
import {
  type CreateUploadResponse,
  createUploadRequestSchema,
  type Input,
  MAX_UPLOAD_FILE_BYTES,
} from "@voluma/contracts/run";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { holdLeave } from "../../shell/deploys";
import type { ScanFile } from "./scan-files";

/** Files PUT at once; enough to fill a lab uplink without starving the page. */
const PARALLEL = 4;
/** Tries per file before it is reported as failed; Retry starts the count again. */
const TRIES = 3;

export type UploadState =
  | { kind: "waiting" }
  /** Bytes sent so far: `useSent`. */
  | { kind: "uploading"; total: number }
  | { kind: "finishing" }
  | { kind: "ready"; input: Input }
  /** These files didn't upload; Retry sends them again. */
  | { kind: "failed"; paths: string[] }
  /** `retry: false`: the scan itself can't be uploaded (too big, a name storage refuses). */
  | { kind: "error"; message: string; retry: boolean };

interface Job {
  name: string;
  files: ScanFile[];
  created?: CreateUploadResponse;
  /** Completed: an input now, not an upload to cancel. */
  done?: true;
  /** What the next attempt PUTs; empty after every file is stored (complete only). */
  paths: string[];
  queued: boolean;
  controller: AbortController;
  /** Bytes sent per path, kept across retries. */
  progress: Map<string, number>;
  frame: number;
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}

function createError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 403) return "Uploading scans needs a lab account.";
    if (error.status === 413) return "This scan is over the upload size limit.";
    if (error.status === 429)
      return "You have other uploads in progress. Finish or remove them, then retry.";
    if (error.status === 503) return "Scan upload isn't available on this server.";
  }
  return "Couldn't start the upload.";
}

/** Why a scan can't be uploaded at all, or undefined. */
function refusal(name: string, files: ScanFile[]): string | undefined {
  const big = files.find((f) => f.file.size > MAX_UPLOAD_FILE_BYTES);
  if (big) return `${big.path} is over 5 GB, the largest file storage takes.`;
  const request = { name, files: files.map((f) => ({ path: f.path, size: f.file.size })) };
  if (!createUploadRequestSchema.safeParse(request).success)
    return "Some file names can't be stored (hidden characters, or a file and a folder with the same name).";
}

/** Bytes sent per scan id, with a listener per id so only that scan's line re-renders. */
function progressStore() {
  const sent = new Map<string, number>();
  const listeners = new Map<string, Set<() => void>>();
  return {
    get: (id: string) => sent.get(id) ?? 0,
    set(id: string, bytes: number) {
      sent.set(id, bytes);
      for (const listener of listeners.get(id) ?? []) listener();
    },
    subscribe(id: string, listener: () => void) {
      const set = listeners.get(id) ?? new Set();
      listeners.set(id, set.add(listener));
      return () => set.delete(listener);
    },
  };
}
export type Progress = ReturnType<typeof progressStore>;

/** A scan's bytes sent, re-rendering its caller (and nothing else) as they change. */
export function useSent(progress: Progress, id: string): number {
  const subscribe = useCallback((l: () => void) => progress.subscribe(id, l), [progress, id]);
  return useSyncExternalStore(subscribe, () => progress.get(id));
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isAbort = (error: unknown) => error instanceof DOMException && error.name === "AbortError";

export function useUploads() {
  const queryClient = useQueryClient();
  const [states, setStates] = useState<Record<string, UploadState>>({});
  const [progress] = useState(progressStore);
  const jobs = useRef(new Map<string, Job>());
  const active = useRef<string>(undefined);

  const set = useCallback(
    (id: string, state: UploadState) =>
      setStates((prev) => (jobs.current.has(id) ? { ...prev, [id]: state } : prev)),
    [],
  );

  const run = useCallback(
    async (id: string, job: Job) => {
      const { signal } = job.controller;
      const total = job.files.reduce((sum, f) => sum + f.file.size, 0);
      const sent = () => [...job.progress.values()].reduce((a, b) => a + b, 0);
      // The byte total is published at most once a frame.
      const report = (path: string, bytes: number) => {
        job.progress.set(path, bytes);
        if (job.frame) return;
        job.frame = requestAnimationFrame(() => {
          job.frame = 0;
          if (!signal.aborted) progress.set(id, sent());
        });
      };
      // Leaving the uploading state drops a pending progress frame, so it can't land after.
      const settle = (state: UploadState) => {
        cancelAnimationFrame(job.frame);
        job.frame = 0;
        set(id, state);
      };
      try {
        if (!job.created) {
          set(id, { kind: "uploading", total });
          job.created = await createUpload({
            name: job.name,
            files: job.files.map((f) => ({ path: f.path, size: f.file.size })),
          });
          // Removed (or the page left) while this was being created: `remove` saw no upload to
          // cancel, so free its place under the open-upload limit here.
          if (signal.aborted) {
            void cancelUpload(job.created.inputId).catch(() => {});
            return;
          }
        }
        const created = job.created;
        // Only new PUTs need a live URL; a complete-only retry works after expiry.
        if (job.paths.length > 0 && Date.parse(created.expiresAt) <= Date.now()) {
          return settle({
            kind: "error",
            message: "This upload expired. Remove the scan and drop it again.",
            retry: false,
          });
        }
        progress.set(id, sent());
        set(id, { kind: "uploading", total });
        const urls = new Map(created.uploads.map((u) => [u.path, u.url]));
        const files = new Map(job.files.map((f) => [f.path, f.file]));
        const queue = [...job.paths];
        const failed: string[] = [];
        const worker = async () => {
          for (let path = queue.shift(); path !== undefined; path = queue.shift()) {
            const file = files.get(path) as File;
            let ok = false;
            for (let attempt = 1; attempt <= TRIES && !ok; attempt++) {
              try {
                await putUploadFile(urls.get(path) as string, file, {
                  signal,
                  onProgress: (bytes) => report(path, bytes),
                });
                ok = true;
              } catch {
                if (signal.aborted) return;
                report(path, 0);
                if (attempt < TRIES) await wait(1000 * 2 ** attempt);
              }
            }
            if (signal.aborted) return;
            if (ok) report(path, file.size);
            else failed.push(path);
          }
        };
        await Promise.all(Array.from({ length: PARALLEL }, worker));
        if (signal.aborted) return;
        job.paths = failed;
        if (failed.length > 0) return settle({ kind: "failed", paths: failed });
        settle({ kind: "finishing" });
        const input = await completeUpload(created.inputId);
        job.done = true;
        if (signal.aborted) return;
        settle({ kind: "ready", input });
        void queryClient.invalidateQueries({ queryKey: inputsQuery().queryKey });
      } catch (error) {
        if (signal.aborted || isAbort(error)) return;
        if (error instanceof UploadIncompleteError) {
          for (const path of error.missing) job.progress.set(path, 0);
          job.paths = error.missing;
          return settle({ kind: "failed", paths: error.missing });
        }
        settle({
          kind: "error",
          message: job.created ? "Couldn't finish the upload." : createError(error),
          retry: true,
        });
      }
    },
    [queryClient, set, progress],
  );

  const pump = useCallback(() => {
    if (active.current) return;
    const next = [...jobs.current].find(([, job]) => job.queued);
    if (!next) return;
    const [id, job] = next;
    job.queued = false;
    active.current = id;
    void run(id, job).finally(() => {
      if (active.current === id) active.current = undefined;
      pump();
    });
  }, [run]);

  const add = useCallback(
    (id: string, name: string, files: ScanFile[]) => {
      const refused = refusal(name, files);
      jobs.current.set(id, {
        name,
        files,
        paths: files.map((f) => f.path),
        queued: !refused,
        controller: new AbortController(),
        progress: new Map(),
        frame: 0,
      });
      set(id, refused ? { kind: "error", message: refused, retry: false } : { kind: "waiting" });
      pump();
    },
    [pump, set],
  );

  const retry = useCallback(
    (id: string) => {
      const job = jobs.current.get(id);
      if (!job || active.current === id) return;
      job.controller = new AbortController();
      job.queued = true;
      set(id, { kind: "waiting" });
      pump();
    },
    [pump, set],
  );

  const remove = useCallback(
    (id: string) => {
      const job = jobs.current.get(id);
      if (!job) return;
      job.controller.abort();
      jobs.current.delete(id);
      setStates(({ [id]: _, ...rest }) => rest);
      if (active.current === id) {
        active.current = undefined;
        pump();
      }
      // Frees the upload's place under the open-upload limit; if this fails it expires. A
      // completed scan stays among the earlier uploads.
      if (job.created && !job.done) void cancelUpload(job.created.inputId).catch(() => {});
    },
    [pump],
  );

  // Leaving the page drops the uploads still under way.
  useEffect(() => {
    const all = jobs.current;
    return () => {
      for (const job of all.values()) {
        job.controller.abort();
        if (job.created && !job.done) void cancelUpload(job.created.inputId).catch(() => {});
      }
      all.clear();
    };
  }, []);

  const busy = Object.values(states).some(
    (s) => s.kind === "waiting" || s.kind === "uploading" || s.kind === "finishing",
  );
  useEffect(() => {
    if (!busy) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    // A deploy's reload waits too, until the last scan is uploaded, fails or is removed.
    const release = holdLeave();
    return () => {
      window.removeEventListener("beforeunload", warn);
      release();
    };
  }, [busy]);

  return { states, progress, add, retry, remove };
}
