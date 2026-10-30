/**
 * Typed client for apps/api over the contracts. Web features call the API only
 * through here. Requests are same-origin; a 401 on any call except `getMe`
 * emits "signed out" so the shell can show the sign-in screen.
 */
import { logoutResponseSchema, type Me, meResponseSchema } from "@voluma/contracts/auth";
import { type DownloadDescriptor, downloadDescriptorSchema } from "@voluma/contracts/download";
import { type RunEvent, runEventSchema } from "@voluma/contracts/events";
import {
  type SendRunMessageRequest,
  type SendRunMessageResponse,
  sendRunMessageRequestSchema,
  sendRunMessageResponseSchema,
} from "@voluma/contracts/messages";
import {
  type AcceptCheckRequest,
  acceptCheckRequestSchema,
  type MarkReviewedRequest,
  markReviewedRequestSchema,
  type ReviewDecisionResponse,
  type ReviewRun,
  reviewDecisionResponseSchema,
  reviewRunSchema,
} from "@voluma/contracts/review";
import {
  type CreateUploadRequest,
  type CreateUploadResponse,
  completeUploadConflictSchema,
  createUploadResponseSchema,
  type Input,
  inputSchema,
  listInputsResponseSchema,
  listRunsResponseSchema,
  type ResendKeysRequest,
  type Run,
  runSchema,
  type StartRunRequest,
  type VisitorKeys,
} from "@voluma/contracts/run";
import {
  type CreateReviewSnapshotRequest,
  createReviewSnapshotRequestSchema,
  listReviewSnapshotsResponseSchema,
  type ReviewSnapshot,
  reviewSnapshotSchema,
} from "@voluma/contracts/snapshot";
import { END_EVENT, LIVE_EVENT, type LiveFrame, liveFrameSchema } from "@voluma/contracts/stream";
import {
  type CreateStudyRequest,
  listStudiesResponseSchema,
  type StudyDetail,
  type StudySummary,
  studyDetailSchema,
} from "@voluma/contracts/study";

/**
 * A non-OK API response. Branch on `status` (403, 415, 5xx) rather than parsing the message;
 * `detail` is the server's `error` text for a person to read, when it sent one.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    url: string,
    readonly detail?: string,
  ) {
    super(`${url}: ${status}`);
    this.name = "ApiError";
  }
}

const signedOutListeners = new Set<() => void>();

/** Listen for a 401 on any call but `getMe`. Returns the unsubscribe function. */
export function onSignedOut(listener: () => void): () => void {
  signedOutListeners.add(listener);
  return () => signedOutListeners.delete(listener);
}

/** Non-GET requests always carry a JSON body: the server rejects any other content type. */
async function request(
  path: string,
  {
    method = "GET",
    body,
    signal,
  }: { method?: "GET" | "POST"; body?: unknown; signal?: AbortSignal } = {},
): Promise<Response> {
  const post = method !== "GET";
  return fetch(`/api${path}`, {
    method,
    headers: post ? { "content-type": "application/json" } : undefined,
    body: post ? JSON.stringify(body ?? {}) : undefined,
    signal,
  });
}

async function checkResponse(res: Response): Promise<Response> {
  if (res.status === 401) {
    for (const listener of signedOutListeners) listener();
  }
  if (!res.ok) throw new ApiError(res.status, res.url, await errorText(res));
  return res;
}

/** The `{ error }` text of a JSON error body; none when the body is another shape or already read. */
async function errorText(res: Response): Promise<string | undefined> {
  if (res.body?.locked || !res.headers.get("content-type")?.includes("application/json")) return;
  const body: unknown = await res.json().catch(() => undefined);
  const error = (body as { error?: unknown } | undefined)?.error;
  return typeof error === "string" && error ? error : undefined;
}

async function json(res: Response): Promise<unknown> {
  return (await checkResponse(res)).json();
}

/** Resolves a readable input's scan archive; the server chooses storage, never the caller. */
export async function getInputDownload(
  inputId: string,
  signal: AbortSignal,
): Promise<DownloadDescriptor> {
  return downloadDescriptorSchema.parse(
    await json(await request(`/review/inputs/${encodeURIComponent(inputId)}/download`, { signal })),
  );
}

/**
 * Downloads an authorized descriptor without assuming its consumer is a scan
 * importer. Rejects disallowed types/sizes before Fetch, then mismatched headers
 * and ZIP/Part 10 DICOM signatures before consuming the rest of the body.
 * Progress counts downloaded bytes, not extraction. Full format validation and
 * expanded-data limits belong to the importer, not this transfer.
 */
export async function downloadFile(
  descriptor: DownloadDescriptor,
  {
    acceptedMediaTypes,
    maxBytes,
    signal,
    onProgress,
  }: {
    acceptedMediaTypes: readonly string[];
    maxBytes: number;
    signal: AbortSignal;
    onProgress?: (received: number, total: number) => void;
  },
): Promise<File> {
  const download = downloadDescriptorSchema.parse(descriptor);
  if (!acceptedMediaTypes.includes(download.mediaType)) {
    throw new Error("This file type is not supported by this loader.");
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || download.byteLength > maxBytes) {
    throw new Error("This file exceeds the loader's download limit.");
  }
  // Only plain ZIPs and Part 10 DICOMs are signature-checked; opaque formats
  // (for example mesh buffers) must be validated by their consumer.
  const prefix = new Uint8Array(
    download.mediaType === "application/zip"
      ? 4
      : download.mediaType === "application/dicom"
        ? 132
        : 0,
  );
  if (download.byteLength < prefix.length)
    throw new Error("This file is too short for its format.");
  const res = await fetch(download.url, { signal, credentials: "same-origin", redirect: "error" });
  const total = Number(res.headers.get("content-length"));
  const encoding = res.headers.get("content-encoding")?.trim().toLowerCase();
  const reader = res.body?.getReader();
  try {
    await checkResponse(res);
    if (!reader) throw new Error("The file response has no download body.");
    if (
      res.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== download.mediaType ||
      (encoding !== undefined && encoding !== "identity") ||
      total !== download.byteLength
    ) {
      throw new Error("The file response does not match its download descriptor.");
    }
    const chunks: Blob[] = [];
    let received = 0;
    let prefixBytes = 0;
    onProgress?.(0, total);
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > total) throw new Error("The file exceeds its declared size.");
      if (prefixBytes < prefix.length) {
        const length = Math.min(value.byteLength, prefix.length - prefixBytes);
        prefix.set(value.subarray(0, length), prefixBytes);
        prefixBytes += length;
        if (prefixBytes === prefix.length) {
          const valid =
            download.mediaType === "application/dicom"
              ? prefix[128] === 0x44 &&
                prefix[129] === 0x49 &&
                prefix[130] === 0x43 &&
                prefix[131] === 0x4d
              : prefix[0] === 0x50 &&
                prefix[1] === 0x4b &&
                ((prefix[2] === 0x03 && prefix[3] === 0x04) ||
                  (prefix[2] === 0x05 && prefix[3] === 0x06));
          if (!valid) throw new Error("The file bytes do not match its declared format.");
        }
      }
      chunks.push(new Blob([value]));
      onProgress?.(received, total);
    }
    signal.throwIfAborted();
    if (received !== total) throw new Error("The file download is incomplete. Try again.");
    return new File(chunks, download.filename, { type: download.mediaType });
  } finally {
    await reader?.cancel().catch(() => {});
    reader?.releaseLock();
  }
}

/** The signed-in user, or null when signed out. Being signed out on load is not an event. */
export async function getMe(): Promise<Me | null> {
  const res = await request("/auth/me");
  if (res.status === 401) return null;
  return meResponseSchema.parse(await json(res));
}

/** The caller's guest identity, made on first call; null when the server lets no guests in (404). */
export async function startGuest(): Promise<Me | null> {
  const res = await request("/auth/guest", { method: "POST" });
  if (res.status === 404) return null;
  return meResponseSchema.parse(await json(res));
}

/** Starts sign-in: navigates to the identity provider, then back to `returnTo`. The server validates `returnTo`. */
export function signIn(returnTo = location.pathname + location.search): void {
  location.href = `/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`;
}

/** Ends the session, then leaves the app for the identity provider's logout page. */
export async function signOut(): Promise<void> {
  const { logoutUrl } = logoutResponseSchema.parse(
    await json(await request("/auth/logout", { method: "POST" })),
  );
  location.href = logoutUrl;
}

/** Starts a run on a scan of one of the caller's studies (`req.studyId`, `req.inputId`). With `keys` it runs on the caller's own credentials and skips the org's runs-at-once count; either way it waits for the runner to claim it. 409 and 429: the org's limits (see `@voluma/contracts/run`). */
export async function startRun(req: StartRunRequest): Promise<Run> {
  return runSchema.parse(await json(await request("/run/runs", { method: "POST", body: req })));
}

/** Creates a study and starts the runs for `req.start` in one call; a refusal (409, 429) leaves no study. See `@voluma/contracts/study`. */
export async function createStudy(req: CreateStudyRequest): Promise<StudyDetail> {
  return studyDetailSchema.parse(
    await json(await request("/run/studies", { method: "POST", body: req })),
  );
}

/** The caller's readable studies, newest activity first. */
export async function listStudies(): Promise<StudySummary[]> {
  return listStudiesResponseSchema.parse(await json(await request("/run/studies"))).studies;
}

/** A study with its scans, their runs, and the workflow's headline values. */
export async function getStudy(id: string): Promise<StudyDetail> {
  return studyDetailSchema.parse(
    await json(await request(`/run/studies/${encodeURIComponent(id)}`)),
  );
}

export async function getRun(id: string): Promise<Run> {
  return runSchema.parse(await json(await request(`/run/runs/${encodeURIComponent(id)}`)));
}

/** The caller's org's runs (only the caller's own under scope `self`), newest first. */
export async function listRuns(): Promise<Run[]> {
  return listRunsResponseSchema.parse(await json(await request("/run/runs"))).runs;
}

export async function cancelRun(id: string): Promise<Run> {
  return runSchema.parse(
    await json(await request(`/run/runs/${encodeURIComponent(id)}/cancel`, { method: "POST" })),
  );
}

/** Resends a visitor run's keys after the runner lost them (state `awaiting-keys`). */
export async function resendKeys(id: string, keys: VisitorKeys): Promise<Run> {
  const body: ResendKeysRequest = { keys };
  return runSchema.parse(
    await json(await request(`/run/runs/${encodeURIComponent(id)}/keys`, { method: "POST", body })),
  );
}

/** A run's review data, built from its event log on each call. 404: unreadable or unknown run; 409: the run has no plan. */
export async function getReviewRun(runId: string): Promise<ReviewRun> {
  return reviewRunSchema.parse(
    await json(await request(`/review/runs/${encodeURIComponent(runId)}`)),
  );
}

/** Accepts one current-result check; never marks the run reviewed. */
export async function acceptCheck(
  runId: string,
  checkId: string,
  body: AcceptCheckRequest,
): Promise<ReviewDecisionResponse> {
  return reviewDecisionResponseSchema.parse(
    await json(
      await request(
        `/review/runs/${encodeURIComponent(runId)}/checks/${encodeURIComponent(checkId)}/accept`,
        { method: "POST", body: acceptCheckRequestSchema.parse(body) },
      ),
    ),
  );
}

/** Explicitly completes review of a revision with no open checks. */
export async function markReviewed(
  runId: string,
  body: MarkReviewedRequest,
): Promise<ReviewDecisionResponse> {
  return reviewDecisionResponseSchema.parse(
    await json(
      await request(`/review/runs/${encodeURIComponent(runId)}/mark-reviewed`, {
        method: "POST",
        body: markReviewedRequestSchema.parse(body),
      }),
    ),
  );
}

/**
 * Sends the main agent a message (and optional marks, a PNG snapshot, or Go) about a finished run;
 * reopens a run that ended `completed`. Keep `body.id` across retries. Refusals and limits:
 * `messages.ts`. The chat comes back on the run's event stream: read it with `conversation`.
 */
export async function sendRunMessage(
  runId: string,
  body: SendRunMessageRequest,
): Promise<SendRunMessageResponse> {
  return sendRunMessageResponseSchema.parse(
    await json(
      await request(`/review/runs/${encodeURIComponent(runId)}/messages`, {
        method: "POST",
        body: sendRunMessageRequestSchema.parse(body),
      }),
    ),
  );
}

/**
 * Where the browser reads the view snapshot of a message (`person.message`'s `snapshotKey`,
 * by the message's id: the `id` the panel sent). A PNG; 404: unreadable run or no such snapshot.
 */
export const runMessageSnapshotUrl = (runId: string, messageId: string) =>
  `/api/review/runs/${encodeURIComponent(runId)}/messages/${encodeURIComponent(messageId)}/snapshot`;

/**
 * Where the browser reads one of a run's files: evidence, a data file, a volume or a mesh,
 * by the `sha256` its `Asset` (or `npy` volume, or mesh) carries. JPEG and PNG come back as
 * images; anything else is an attachment. 404: unreadable run or no such file; 503: no file
 * storage configured. Only files under the run's own prefix, not the reference run's keys.
 */
export const reviewFileUrl = (runId: string, sha256: string) =>
  `/api/review/runs/${encodeURIComponent(runId)}/files/${encodeURIComponent(sha256)}`;

/**
 * Where the browser reads a converted asset (zarr level or mesh file) of a run: `path` is
 * relative to the asset prefix, as `assets.ready` lists it (`reviewAssetKey`). 302 to a
 * presigned GET; 404: unreadable run or bad path.
 */
export const reviewAssetUrl = (runId: string, sha256: string, path: string) =>
  `/api/review/runs/${encodeURIComponent(runId)}/assets/${encodeURIComponent(sha256)}/${path
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;

/** Prepared snapshot API: keep body.id unchanged when retrying a failed or interrupted save. */
export async function createReviewSnapshot(
  runId: string,
  body: CreateReviewSnapshotRequest,
): Promise<ReviewSnapshot> {
  return reviewSnapshotSchema.parse(
    await json(
      await request(`/review/runs/${encodeURIComponent(runId)}/snapshots`, {
        method: "POST",
        body: createReviewSnapshotRequestSchema.parse(body),
      }),
    ),
  );
}

/** Prepared snapshot API: returns the run's immutable screenshot records, oldest first. */
export async function listReviewSnapshots(
  runId: string,
  signal?: AbortSignal,
): Promise<ReviewSnapshot[]> {
  return listReviewSnapshotsResponseSchema.parse(
    await json(await request(`/review/runs/${encodeURIComponent(runId)}/snapshots`, { signal })),
  ).snapshots;
}

/** Inputs the caller may start a run on, newest first. */
export async function listInputs(): Promise<Input[]> {
  return listInputsResponseSchema.parse(await json(await request("/run/inputs"))).inputs;
}

/**
 * Creates an upload: a new input and a presigned URL per file (`@voluma/contracts/run`,
 * Uploads). PUT each file with `putUploadFile`, then call `completeUpload`. 403 for a
 * guest, 413 over the server's limits, 429 when the caller has too many uploads open.
 */
export async function createUpload(req: CreateUploadRequest): Promise<CreateUploadResponse> {
  return createUploadResponseSchema.parse(
    await json(await request("/run/inputs", { method: "POST", body: req })),
  );
}

/** Complete's 409: these declared files are not stored at their declared size. */
export class UploadIncompleteError extends ApiError {
  constructor(
    readonly missing: string[],
    url: string,
  ) {
    super(409, url);
    this.name = "UploadIncompleteError";
  }
}

/**
 * Makes an upload usable once every file is stored. Throws `UploadIncompleteError` naming
 * the files that aren't: PUT them again, then complete again.
 */
export async function completeUpload(inputId: string): Promise<Input> {
  const res = await request(`/run/inputs/${encodeURIComponent(inputId)}/complete`, {
    method: "POST",
  });
  if (res.status === 409) {
    const { missing } = completeUploadConflictSchema.parse(await res.json());
    throw new UploadIncompleteError(missing, res.url);
  }
  return inputSchema.parse(await json(res));
}

/** Drops an uncompleted upload and its stored files. 409 once it is completed. */
export async function cancelUpload(inputId: string): Promise<void> {
  await checkResponse(
    await request(`/run/inputs/${encodeURIComponent(inputId)}/cancel`, { method: "POST" }),
  );
}

/**
 * PUTs one file's bytes to its presigned URL (straight to object storage, not the API),
 * reporting bytes sent. XHR, not fetch: fetch can't report upload progress. Rejects with
 * `ApiError` (status 0 for a network failure) or an `AbortError` when `signal` aborts.
 */
export function putUploadFile(
  url: string,
  file: Blob,
  { onProgress, signal }: { onProgress?: (sent: number) => void; signal?: AbortSignal } = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    const aborted = () => new DOMException("Upload aborted", "AbortError");
    if (signal?.aborted) return reject(aborted());
    const xhr = new XMLHttpRequest();
    const abort = () => xhr.abort();
    const settle = (error?: Error) => {
      signal?.removeEventListener("abort", abort);
      error ? reject(error) : resolve();
    };
    xhr.open("PUT", url);
    xhr.upload.onprogress = (e) => onProgress?.(e.loaded);
    xhr.onload = () =>
      settle(
        xhr.status >= 200 && xhr.status < 300 ? undefined : new ApiError(xhr.status, "upload"),
      );
    xhr.onerror = () => settle(new ApiError(0, "upload"));
    xhr.onabort = () => settle(aborted());
    signal?.addEventListener("abort", abort, { once: true });
    xhr.send(file);
  });
}

/**
 * Opens a run's event stream (`@voluma/contracts/stream`): `onEvent` gets each durable event
 * in order, once. `EventSource` reconnects by itself and resumes from the last event's `id`.
 * `after` is the highest `seq` the caller already holds, for the first connect only. `onError`
 * is told of a message that fails to parse; a dropped connection is not an error. `onLive` gets
 * each live frame (token-level text, reasoning, tool arguments, tool output): unstored, no
 * cursor, not replayed on reconnect; see the contract for how to fold them.
 * `onClosed` fires when the stream is over for good (`EventSource` hides the status): refetch the
 * run to tell an ended run from a 404, or call `getMe` to catch a sign-out. Returns the
 * function that closes the stream.
 */
export function subscribe(
  runId: string,
  handlers: {
    onEvent: (event: RunEvent) => void;
    onLive?: (frame: LiveFrame) => void;
    onError?: (error: unknown) => void;
    /**
     * The stream will not reconnect. `error`: the server refused or failed it (404, 401, 5xx);
     * otherwise it sent the run's end (also at once for an ended run with nothing after `after`).
     */
    onClosed?: (error: boolean) => void;
  },
  after = 0,
): () => void {
  const source = new EventSource(
    `/api/run/runs/${encodeURIComponent(runId)}/stream?after=${after}`,
  );
  source.onmessage = (e) => {
    try {
      handlers.onEvent(runEventSchema.parse(JSON.parse(e.data)));
    } catch (error) {
      handlers.onError?.(error);
    }
  };
  if (handlers.onLive) {
    const onLive = handlers.onLive;
    source.addEventListener(LIVE_EVENT, (e) => {
      try {
        onLive(liveFrameSchema.parse(JSON.parse((e as MessageEvent<string>).data)));
      } catch (error) {
        handlers.onError?.(error);
      }
    });
  }
  // The run ended and every event has been sent; closing here skips the reconnect.
  source.addEventListener(END_EVENT, () => {
    source.close();
    handlers.onClosed?.(false);
  });
  source.onerror = () => {
    if (source.readyState === EventSource.CLOSED) handlers.onClosed?.(true);
  };
  return () => source.close();
}
