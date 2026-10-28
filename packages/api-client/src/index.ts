/**
 * Typed client for apps/api over the contracts. Web features call the API only
 * through here. Requests are same-origin; a 401 on any call except `getMe`
 * emits "signed out" so the shell can show the sign-in screen.
 */
import { logoutResponseSchema, type Me, meResponseSchema } from "@voluma/contracts/auth";
import { type DownloadDescriptor, downloadDescriptorSchema } from "@voluma/contracts/download";
import { type RunEvent, runEventSchema } from "@voluma/contracts/events";
import {
  type Input,
  listInputsResponseSchema,
  listRunsResponseSchema,
  type ResendKeysRequest,
  type Run,
  runSchema,
  type StartRunRequest,
  type VisitorKeys,
} from "@voluma/contracts/run";
import { LIVE_EVENT, type LiveFrame, liveFrameSchema } from "@voluma/contracts/stream";

/** A non-OK API response. Branch on `status` (403, 415, 5xx) rather than parsing the message. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    url: string,
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

function checkResponse(res: Response): Response {
  if (res.status === 401) {
    for (const listener of signedOutListeners) listener();
  }
  if (!res.ok) throw new ApiError(res.status, res.url);
  return res;
}

async function json(res: Response): Promise<unknown> {
  return checkResponse(res).json();
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
    checkResponse(res);
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

/** Starts a run on an input the caller can read. With `keys` it runs on the caller's own credentials and skips the org's runs-at-once count; either way it waits for the runner to claim it. 409 and 429: the org's limits (see `@voluma/contracts/run`). */
export async function startRun(req: StartRunRequest): Promise<Run> {
  return runSchema.parse(await json(await request("/run/runs", { method: "POST", body: req })));
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

/** Inputs the caller may start a run on, newest first. */
export async function listInputs(): Promise<Input[]> {
  return listInputsResponseSchema.parse(await json(await request("/run/inputs"))).inputs;
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
    /** The stream will not reconnect: the run has ended, or the server refused it (404, 401). */
    onClosed?: () => void;
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
  source.onerror = () => {
    if (source.readyState === EventSource.CLOSED) handlers.onClosed?.();
  };
  return () => source.close();
}
