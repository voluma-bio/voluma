/**
 * Typed client for apps/api over the contracts. Web features call the API only
 * through here. Requests are same-origin; a 401 on any call except `getMe`
 * emits "signed out" so the shell can show the sign-in screen.
 */
import { logoutResponseSchema, type Me, meResponseSchema } from "@voluma/contracts/auth";
import { type RunEvent, runEventSchema } from "@voluma/contracts/events";
import {
  type CreateUploadRequest,
  type CreateUploadResponse,
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
  { method = "GET", body }: { method?: "GET" | "POST"; body?: unknown } = {},
): Promise<Response> {
  const post = method !== "GET";
  return fetch(`/api${path}`, {
    method,
    headers: post ? { "content-type": "application/json" } : undefined,
    body: post ? JSON.stringify(body ?? {}) : undefined,
  });
}

async function json(res: Response): Promise<unknown> {
  if (res.status === 401) {
    for (const listener of signedOutListeners) listener();
  }
  if (!res.ok) throw new ApiError(res.status, res.url);
  return res.json();
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
 * Creates an upload: a new input and a presigned URL per file (`@voluma/contracts/run`,
 * Uploads). PUT each file with `putUploadFile`, then call `completeUpload`. 403 for a
 * guest, 413 over the server's limits.
 */
export async function createUpload(req: CreateUploadRequest): Promise<CreateUploadResponse> {
  return createUploadResponseSchema.parse(
    await json(await request("/run/inputs", { method: "POST", body: req })),
  );
}

/** Makes an upload usable once every file is stored. 409: some aren't; PUT them again. */
export async function completeUpload(inputId: string): Promise<Input> {
  return inputSchema.parse(
    await json(
      await request(`/run/inputs/${encodeURIComponent(inputId)}/complete`, { method: "POST" }),
    ),
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
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.upload.onprogress = (e) => onProgress?.(e.loaded);
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300
        ? resolve()
        : reject(new ApiError(xhr.status, "upload"));
    xhr.onerror = () => reject(new ApiError(0, "upload"));
    xhr.onabort = () => reject(new DOMException("Upload aborted", "AbortError"));
    signal?.addEventListener("abort", () => xhr.abort(), { once: true });
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
