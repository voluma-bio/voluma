/**
 * "Upload scan" on the start screen's scan picker: pick a folder or files, name the scan,
 * then PUT each file straight to storage (`@voluma/contracts/run`, Uploads) with progress,
 * retries and cancel. A completed upload joins the picker, selected. Members only.
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
import {
  type CreateUploadResponse,
  createUploadRequestSchema,
  type Input,
  MAX_UPLOAD_FILE_BYTES,
} from "@voluma/contracts/run";
import { Button } from "@voluma/ui";
import { FolderOpen, Upload } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

/** Files PUT at once; enough to fill a lab uplink without starving the page. */
const PARALLEL = 4;
/** Tries per file before it is reported as failed; Retry starts the count again. */
const TRIES = 3;

interface Picked {
  file: File;
  /** Relative to the picked folder, `/` separated: what the worker sees under /inputs. */
  path: string;
}

type Phase =
  | { kind: "pick" }
  | { kind: "creating" }
  | { kind: "uploading" }
  | { kind: "finishing" }
  | { kind: "failed"; paths: string[] }
  /** `retryComplete`: every file is stored and only complete failed. */
  | { kind: "error"; message: string; retryComplete?: true };

/** A folder pick reports `top/sub/file`; the top folder becomes the default name, not a path segment. */
function fromFileList(list: FileList): { picked: Picked[]; folder?: string } {
  const all = [...list].map((file) => {
    const rel = file.webkitRelativePath || file.name;
    return { file, parts: rel.split("/") };
  });
  const folder = all[0]?.file.webkitRelativePath ? all[0].parts[0] : undefined;
  const picked = all
    .map(({ file, parts }) => ({
      file,
      path: (folder ? parts.slice(1) : parts).join("/").normalize("NFC"),
    }))
    // Hidden files (.DS_Store, ._ resource forks) are not part of a scan.
    .filter((p) => !p.path.split("/").some((s) => s.startsWith(".")))
    .sort((a, b) => a.path.localeCompare(b.path));
  return { picked, folder };
}

function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}

function createError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 403) return "Uploading scans needs a lab account.";
    if (error.status === 413) return "This scan is over the upload size limit.";
    if (error.status === 429)
      return "You have other uploads in progress. Finish or cancel them first.";
    if (error.status === 503) return "Scan upload isn't available on this server.";
  }
  return "Couldn't start the upload. Try again.";
}

interface Attempt {
  controller: AbortController;
  /** Bytes sent per path, carried over from the attempt this one retries. */
  progress: Map<string, number>;
  /** The pending animation frame that publishes the byte total, or 0. */
  frame: number;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function ScanUpload({ onUploaded }: { onUploaded: (input: Input) => void }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<Picked[]>([]);
  const [name, setName] = useState("");
  const [phase, setPhase] = useState<Phase>({ kind: "pick" });
  /** The upload the server created; set once, cleared only by reset. */
  const [upload, setUpload] = useState<CreateUploadResponse>();
  const [sent, setSent] = useState(0);
  const [doneFiles, setDoneFiles] = useState(0);
  /**
   * The attempt in flight. Every async step checks it is still the current one before
   * writing state, so a cancelled or superseded attempt can't touch the panel.
   */
  const attempt = useRef<Attempt>(undefined);
  const folderInput = useRef<HTMLInputElement>(null);
  const filesInput = useRef<HTMLInputElement>(null);

  const total = useMemo(() => picked.reduce((sum, p) => sum + p.file.size, 0), [picked]);
  const busy =
    phase.kind === "creating" || phase.kind === "uploading" || phase.kind === "finishing";

  // Leaving the page mid-upload loses it; ask first.
  useEffect(() => {
    if (!busy) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [busy]);

  // Validated when the pick or name changes, never on a progress render.
  const request = useMemo(
    () => ({ name: name.trim(), files: picked.map((p) => ({ path: p.path, size: p.file.size })) }),
    [name, picked],
  );
  const tooBig = useMemo(() => picked.find((p) => p.file.size > MAX_UPLOAD_FILE_BYTES), [picked]);
  const invalid = useMemo(
    () => picked.length > 0 && !tooBig && !createUploadRequestSchema.safeParse(request).success,
    [picked, tooBig, request],
  );

  function reset() {
    attempt.current?.controller.abort();
    attempt.current = undefined;
    setUpload(undefined);
    setPicked([]);
    setName("");
    setSent(0);
    setDoneFiles(0);
    setPhase({ kind: "pick" });
  }

  function choose(list: FileList | null) {
    if (!list || list.length === 0) return;
    const next = fromFileList(list);
    setPicked(next.picked);
    if (!name.trim()) {
      setName(next.folder ?? next.picked[0]?.path.replace(/\.[^.]*$/, "") ?? "");
    }
    setPhase({ kind: "pick" });
  }

  /** A new attempt, replacing (and aborting) any earlier one. */
  function begin(): Attempt {
    attempt.current?.controller.abort();
    const next: Attempt = {
      controller: new AbortController(),
      progress: attempt.current?.progress ?? new Map(),
      frame: 0,
    };
    attempt.current = next;
    return next;
  }
  const live = (a: Attempt) => attempt.current === a && !a.controller.signal.aborted;

  /** PUTs `paths` with `current`'s URLs, then completes; what is still missing becomes the failed list. */
  async function send(current: CreateUploadResponse, paths: string[]) {
    // Only new PUTs need a live URL; a complete-only retry works after expiry.
    if (paths.length > 0 && Date.parse(current.expiresAt) <= Date.now()) {
      return setPhase({
        kind: "error",
        message: "This upload has expired. Cancel it and upload the scan again.",
      });
    }
    const a = begin();
    setPhase({ kind: "uploading" });
    const urls = new Map(current.uploads.map((u) => [u.path, u.url]));
    const files = new Map(picked.map((p) => [p.path, p.file]));
    const queue = [...paths];
    const failed: string[] = [];
    // Bytes per path, so a retried file's progress replaces its earlier try; the total is
    // published at most once a frame.
    const report = (path: string, bytes: number) => {
      if (!live(a)) return;
      a.progress.set(path, bytes);
      if (a.frame) return;
      a.frame = requestAnimationFrame(() => {
        a.frame = 0;
        if (live(a)) setSent([...a.progress.values()].reduce((x, y) => x + y, 0));
      });
    };
    const worker = async () => {
      for (let path = queue.shift(); path !== undefined; path = queue.shift()) {
        const file = files.get(path) as File;
        let ok = false;
        for (let attempt = 1; attempt <= TRIES && !ok; attempt++) {
          try {
            await putUploadFile(urls.get(path) as string, file, {
              signal: a.controller.signal,
              onProgress: (bytes) => report(path, bytes),
            });
            ok = true;
          } catch {
            if (!live(a)) return;
            report(path, 0);
            if (attempt < TRIES) await wait(1000 * 2 ** attempt);
          }
        }
        if (!live(a)) return;
        if (ok) {
          report(path, file.size);
          setDoneFiles((n) => n + 1);
        } else failed.push(path);
      }
    };
    await Promise.all(Array.from({ length: PARALLEL }, worker));
    if (!live(a)) return;
    if (failed.length > 0) return setPhase({ kind: "failed", paths: failed });
    // Cancel is hidden from here: the server may already be moving the files.
    setPhase({ kind: "finishing" });
    try {
      const input = await completeUpload(current.inputId);
      if (!live(a)) return;
      await queryClient.invalidateQueries({ queryKey: ["inputs"] });
      onUploaded(input);
      reset();
      setOpen(false);
    } catch (error) {
      if (!live(a)) return;
      if (error instanceof UploadIncompleteError) {
        for (const path of error.missing) report(path, 0);
        setDoneFiles((n) => n - error.missing.length);
        return setPhase({ kind: "failed", paths: error.missing });
      }
      setPhase({
        kind: "error",
        message: "Couldn't finish the upload. Try again.",
        retryComplete: true,
      });
    }
  }

  async function start() {
    // A second click before the re-render that disables the button.
    if (attempt.current) return;
    const a = begin();
    setPhase({ kind: "creating" });
    let created: CreateUploadResponse;
    try {
      created = await createUpload(request);
    } catch (error) {
      if (!live(a)) return;
      attempt.current = undefined;
      setPhase({ kind: "error", message: createError(error) });
      return;
    }
    if (!live(a)) return;
    setUpload(created);
    await send(
      created,
      picked.map((p) => p.path),
    );
  }

  async function cancel() {
    const id = upload?.inputId;
    reset();
    setOpen(false);
    // Frees the upload's place under the open-upload limit; if this fails it expires.
    if (id) await cancelUpload(id).catch(() => {});
  }

  if (!open) {
    return (
      <Button className="mt-2 w-full" onClick={() => setOpen(true)}>
        <Upload className="size-4" aria-hidden />
        Upload scan
      </Button>
    );
  }

  const started = upload !== undefined;
  const creating = phase.kind === "creating";
  const percent = total > 0 ? Math.min(100, Math.floor((sent / total) * 100)) : 0;

  return (
    <section
      aria-label="Upload scan"
      className="mt-3 grid gap-3 rounded-xl border border-border bg-card p-3"
    >
      <div className="flex items-baseline justify-between">
        <h3 className="font-medium">Upload scan</h3>
        {!started && !creating && (
          <button
            type="button"
            className="text-meta text-primary-text hover:underline"
            onClick={() => {
              reset();
              setOpen(false);
            }}
          >
            Close
          </button>
        )}
      </div>

      {!started && !creating && (
        <>
          <div className="grid grid-cols-2 gap-2">
            <Button size="sm" onClick={() => folderInput.current?.click()}>
              <FolderOpen className="size-4" aria-hidden />
              Choose folder
            </Button>
            <Button size="sm" onClick={() => filesInput.current?.click()}>
              Choose files
            </Button>
          </div>
          <input
            ref={folderInput}
            type="file"
            className="hidden"
            // React has no typed prop for these; they make the picker choose a folder.
            {...{ webkitdirectory: "", directory: "" }}
            onChange={(e) => {
              choose(e.target.files);
              e.target.value = "";
            }}
          />
          <input
            ref={filesInput}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              choose(e.target.files);
              e.target.value = "";
            }}
          />
          <p className="text-meta text-muted-foreground">
            A folder of slices (DICOM, TIFF) or volume files, up to 5 GB each. The run sees them as
            they are laid out here.
          </p>
        </>
      )}

      {picked.length > 0 && (
        <>
          <p className="text-ui tabular-nums">
            {picked.length} {picked.length === 1 ? "file" : "files"}, {formatBytes(total)}
          </p>
          <label className="grid gap-1">
            <span className="text-meta font-semibold text-fg-subtle">Name</span>
            <input
              value={name}
              maxLength={200}
              disabled={started || creating}
              onChange={(e) => setName(e.target.value)}
              className="h-9 rounded-lg border border-input bg-card px-3 text-ui outline-none focus-visible:border-ring disabled:opacity-60"
            />
          </label>
        </>
      )}

      {tooBig && (
        <p role="alert" className="text-ui text-destructive">
          {tooBig.path} is over 5 GB, the largest file storage takes.
        </p>
      )}
      {invalid && (
        <p role="alert" className="text-ui text-destructive">
          {name.trim() === ""
            ? "Give the scan a name."
            : "Some file names can't be stored (hidden characters, or a file and a folder with the same name)."}
        </p>
      )}

      {started && (
        <div className="grid gap-1.5">
          <div
            role="progressbar"
            aria-label="Upload progress"
            aria-valuenow={percent}
            aria-valuemin={0}
            aria-valuemax={100}
            className="h-2 overflow-hidden rounded-full bg-muted"
          >
            <div
              className="h-full bg-primary transition-[width]"
              style={{ width: `${percent}%` }}
            />
          </div>
          <p className="flex justify-between text-meta text-muted-foreground tabular-nums">
            <span>
              {doneFiles} of {picked.length} files
            </span>
            <span>
              {formatBytes(sent)} of {formatBytes(total)}
            </span>
          </p>
        </div>
      )}

      {phase.kind === "failed" && (
        <div role="alert" className="grid gap-1 text-ui">
          <p className="text-destructive">
            {phase.paths.length} {phase.paths.length === 1 ? "file" : "files"} didn't upload.
          </p>
          <ul className="max-h-24 overflow-y-auto font-mono text-meta text-muted-foreground">
            {phase.paths.slice(0, 20).map((p) => (
              <li key={p} className="truncate">
                {p}
              </li>
            ))}
            {phase.paths.length > 20 && <li>and {phase.paths.length - 20} more</li>}
          </ul>
        </div>
      )}
      {phase.kind === "error" && (
        <p role="alert" className="text-ui text-destructive">
          {phase.message}
        </p>
      )}

      <div className="flex gap-2">
        {!started && (
          <Button
            variant="primary"
            className="flex-1"
            disabled={picked.length === 0 || invalid || tooBig !== undefined || creating}
            onClick={() => void start()}
          >
            {creating ? "Starting…" : "Upload"}
          </Button>
        )}
        {phase.kind === "failed" && (
          <Button
            variant="primary"
            className="flex-1"
            onClick={() => upload && void send(upload, phase.paths)}
          >
            Retry {phase.paths.length === 1 ? "file" : `${phase.paths.length} files`}
          </Button>
        )}
        {phase.kind === "error" && phase.retryComplete && upload && (
          <Button variant="primary" className="flex-1" onClick={() => void send(upload, [])}>
            Try again
          </Button>
        )}
        {phase.kind === "finishing" && <p className="text-ui text-muted-foreground">Finishing…</p>}
        {started && phase.kind !== "finishing" && (
          <Button
            className={phase.kind === "uploading" ? "flex-1" : undefined}
            onClick={() => void cancel()}
          >
            Cancel upload
          </Button>
        )}
      </div>
    </section>
  );
}
