/**
 * Typed client for apps/api over the contracts. Web features call the API only
 * through here. Requests are same-origin; a 401 on any call except `getMe`
 * emits "signed out" so the shell can show the sign-in screen. A response that
 * fails its schema is a `ContractError`, handed to the app's `onContractError`
 * handler so the app can move to the deployed code.
 */
import {
  type AcceptToCheckRequest,
  acceptToCheckRequestSchema,
  acceptToCheckResponseSchema,
  deleteMarkResponseSchema,
  type PlaceMarkRequest,
  placeMarkRequestSchema,
  placeMarkResponseSchema,
  type SaveViewRequest,
  saveViewRequestSchema,
  saveViewResponseSchema,
} from "@voluma/contracts/agent-events";
import { logoutResponseSchema, type Me, meResponseSchema } from "@voluma/contracts/auth";
import { type RunEvent, runEventSchema } from "@voluma/contracts/events";
import {
  type AnswerApprovalRequest,
  answerApprovalRequestSchema,
  answerApprovalResponseSchema,
  type SendRunMessageRequest,
  type SendRunMessageResponse,
  sendRunMessageRequestSchema,
  sendRunMessageResponseSchema,
} from "@voluma/contracts/messages";
import {
  type CreateUploadRequest,
  type CreateUploadResponse,
  completeUploadConflictSchema,
  createUploadResponseSchema,
  type Input,
  inputSchema,
  listInputsResponseSchema,
  listRunsResponseSchema,
  type OwnKeys,
  type ResendKeysRequest,
  type Run,
  type RunModelsResponse,
  type RunRead,
  runModelsResponseSchema,
  runReadSchema,
  runSchema,
  type StartRunRequest,
} from "@voluma/contracts/run";
import {
  type UpdateUserSettingsRequest,
  type UserSettings,
  userSettingsSchema,
} from "@voluma/contracts/settings";
import { END_EVENT } from "@voluma/contracts/stream";
import {
  type CreateStudyRequest,
  listStudiesResponseSchema,
  type StudyDetail,
  type StudySummary,
  studyDetailSchema,
} from "@voluma/contracts/study";

/** A non-OK API response. Branch on `status` (403, 415, 5xx) rather than parsing the message. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    url: string,
    /** The `error` text of a JSON error body, when the server sent one. */
    readonly serverMessage?: string,
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
  }: { method?: "GET" | "POST" | "DELETE"; body?: unknown; signal?: AbortSignal } = {},
): Promise<Response> {
  const post = method !== "GET";
  const res = await fetch(`/api${path}`, {
    method,
    headers: post ? { "content-type": "application/json" } : undefined,
    body: post ? JSON.stringify(body ?? {}) : undefined,
    signal,
  });
  if (post) writes.add(res);
  return res;
}

/** Responses to non-GET requests, so a `ContractError` can say whether its call changed something. */
const writes = new WeakSet<Response>();

function checkResponse(res: Response, serverMessage?: string): Response {
  if (res.status === 401) {
    for (const listener of signedOutListeners) listener();
  }
  if (!res.ok) throw new ApiError(res.status, res.url, serverMessage);
  return res;
}

/** The `error` text of a failed response's JSON body; none when the body is something else. */
async function errorMessage(res: Response): Promise<string | undefined> {
  try {
    const body: unknown = await res.json();
    const error = (body as { error?: unknown }).error;
    return typeof error === "string" ? error : undefined;
  } catch {
    return undefined;
  }
}

async function json(res: Response): Promise<unknown> {
  return checkResponse(res, res.ok ? undefined : await errorMessage(res)).json();
}

/**
 * A response that doesn't match the contract this bundle was built against: the API was most
 * likely deployed with a changed shape while this tab kept the old code. `url` names the call;
 * `write` is true for a non-GET call, which may have changed something before its answer failed.
 */
export class ContractError extends Error {
  constructor(
    readonly url: string,
    readonly write: boolean,
    cause: unknown,
  ) {
    super(`${url}: the response doesn't match this app's contract`, { cause });
    this.name = "ContractError";
  }
}

/** Resolves true when the page is leaving for the deployed app, false to let the error surface. */
type ContractErrorHandler = (error: ContractError) => Promise<boolean>;
let contractErrorHandler: ContractErrorHandler = async () => false;

/**
 * Decide what every `ContractError` does; one handler for the app. While it decides, the failed
 * call stays pending. When it answers that the page is leaving, the call never settles, so no
 * error renders on the way out; otherwise the call throws the `ContractError`.
 */
export function onContractError(handler: ContractErrorHandler): void {
  contractErrorHandler = handler;
}

type Schema<T> = { parse(data: unknown): T };

/** Every response body is parsed here, so each mismatch is a `ContractError`. */
function matches<T>(
  schema: Schema<T>,
  data: unknown,
  url: string,
  write: boolean,
): { ok: true; value: T } | { ok: false; error: ContractError } {
  try {
    return { ok: true, value: schema.parse(data) };
  } catch (cause) {
    return { ok: false, error: new ContractError(url, write, cause) };
  }
}

/** `data`, read from `res`, as `schema` says; a mismatch goes to the app's handler. */
async function parse<T>(schema: Schema<T>, data: unknown, res: Response): Promise<T> {
  const parsed = matches(schema, data, res.url, writes.has(res));
  if (parsed.ok) return parsed.value;
  if (await contractErrorHandler(parsed.error)) return new Promise<never>(() => {});
  throw parsed.error;
}

async function read<T>(schema: Schema<T>, res: Response): Promise<T> {
  return parse(schema, await json(res), res);
}

/** The signed-in user, or null when signed out. Being signed out on load is not an event. */
export async function getMe(): Promise<Me | null> {
  const res = await request("/auth/me");
  if (res.status === 401) return null;
  return read(meResponseSchema, res);
}

/** The current user's personal settings; defaults until they save their first preference. */
export async function getUserSettings(): Promise<UserSettings> {
  return read(userSettingsSchema, await request("/user/settings"));
}

/** Saves only the supplied preferences for the current user, never another identity. */
export async function updateUserSettings(patch: UpdateUserSettingsRequest): Promise<UserSettings> {
  return read(userSettingsSchema, await request("/user/settings", { method: "POST", body: patch }));
}

/** The caller's guest identity, made on first call; null when the server lets no guests in (404). */
export async function startGuest(): Promise<Me | null> {
  const res = await request("/auth/guest", { method: "POST" });
  if (res.status === 404) return null;
  return read(meResponseSchema, res);
}

/** Starts sign-in: navigates to the identity provider, then back to `returnTo`. The server validates `returnTo`. */
export function signIn(returnTo = location.pathname + location.search): void {
  location.href = `/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`;
}

/** Ends the session, then leaves the app for the identity provider's logout page. */
export async function signOut(): Promise<void> {
  const { logoutUrl } = await read(
    logoutResponseSchema,
    await request("/auth/logout", { method: "POST" }),
  );
  location.href = logoutUrl;
}

/** Starts a run on an input of one of the caller's studies (`req.studyId`, `req.inputId`). With `keys` it runs on the caller's own credentials and skips the org's runs-at-once count; either way it waits for the runner to claim it. 403 `no-key` and 429: the limits (see `@voluma/contracts/run`). */
export async function startRun(req: StartRunRequest): Promise<Run> {
  return read(runSchema, await request("/run/runs", { method: "POST", body: req }));
}

/** The models a start may pick; see `runModelsResponseSchema`. */
export async function getRunModels(): Promise<RunModelsResponse> {
  return read(runModelsResponseSchema, await request("/run/models"));
}

/** Creates a study and starts the runs for `req.start` in one call; a refusal (409, 429) leaves no study. See `@voluma/contracts/study`. */
export async function createStudy(req: CreateStudyRequest): Promise<StudyDetail> {
  return read(studyDetailSchema, await request("/run/studies", { method: "POST", body: req }));
}

/** The caller's readable studies, newest activity first. */
export async function listStudies(): Promise<StudySummary[]> {
  return (await read(listStudiesResponseSchema, await request("/run/studies"))).studies;
}

/** A study with its inputs, their runs, and the workflow's headline values. */
export async function getStudy(id: string): Promise<StudyDetail> {
  return read(studyDetailSchema, await request(`/run/studies/${encodeURIComponent(id)}`));
}

export async function getRun(id: string): Promise<RunRead> {
  return read(runReadSchema, await request(`/run/runs/${encodeURIComponent(id)}`));
}

/** The caller's org's runs (only the caller's own, plus the examples), newest first. */
export async function listRuns(): Promise<Run[]> {
  return (await read(listRunsResponseSchema, await request("/run/runs"))).runs;
}

export async function cancelRun(id: string): Promise<RunRead> {
  return read(
    runReadSchema,
    await request(`/run/runs/${encodeURIComponent(id)}/cancel`, { method: "POST" }),
  );
}

/** Resends an own-key run's keys after the runner lost them (state `awaiting-keys`). */
export async function resendKeys(id: string, keys: OwnKeys): Promise<RunRead> {
  const body: ResendKeysRequest = { keys };
  return read(
    runReadSchema,
    await request(`/run/runs/${encodeURIComponent(id)}/keys`, { method: "POST", body }),
  );
}

/**
 * Looks right on one To check item of an output version. The decision
 * comes back on the run's event stream as `tocheck.resolved`: reconnect it to see it.
 */
export async function acceptToCheck(runId: string, body: AcceptToCheckRequest): Promise<void> {
  await read(
    acceptToCheckResponseSchema,
    await request(`/review/runs/${encodeURIComponent(runId)}/tocheck/accept`, {
      method: "POST",
      body: acceptToCheckRequestSchema.parse(body),
    }),
  );
}

/**
 * Saves a view of an output. It comes back on the run's event stream
 * as `view.saved`: reconnect it to see it.
 */
export async function saveView(runId: string, body: SaveViewRequest): Promise<void> {
  await read(
    saveViewResponseSchema,
    await request(`/review/runs/${encodeURIComponent(runId)}/views`, {
      method: "POST",
      body: saveViewRequestSchema.parse(body),
    }),
  );
}

/**
 * Places or changes a mark of yours; it comes back on the run's event
 * stream as `mark.placed`.
 */
export async function placeMark(runId: string, body: PlaceMarkRequest): Promise<void> {
  await read(
    placeMarkResponseSchema,
    await request(`/review/runs/${encodeURIComponent(runId)}/marks`, {
      method: "POST",
      body: placeMarkRequestSchema.parse(body),
    }),
  );
}

/** Takes a mark of yours away; it comes back on the stream as `mark.deleted`. */
export async function deleteMark(runId: string, markId: string): Promise<void> {
  await read(
    deleteMarkResponseSchema,
    await request(`/review/runs/${encodeURIComponent(runId)}/marks/${encodeURIComponent(markId)}`, {
      method: "DELETE",
    }),
  );
}

/**
 * Sends the main agent a message (and optional marks, a view snapshot, or Go) about a finished run;
 * reopens a run that ended `completed`. Keep `body.id` across retries. Refusals and limits:
 * `messages.ts`. The conversation comes back on the run's event stream: the `person.message` event and the agent's replies.
 */
export async function sendRunMessage(
  runId: string,
  body: SendRunMessageRequest,
): Promise<SendRunMessageResponse> {
  return read(
    sendRunMessageResponseSchema,
    await request(`/review/runs/${encodeURIComponent(runId)}/messages`, {
      method: "POST",
      body: sendRunMessageRequestSchema.parse(body),
    }),
  );
}

/**
 * Answers a call main holds for you. `requestId` is the id of the
 * `approval.requested` event. The answer comes back on the run's event stream as `approval.given`
 * or `approval.declined`.
 */
export async function answerApproval(
  runId: string,
  requestId: string,
  body: AnswerApprovalRequest,
): Promise<void> {
  await read(
    answerApprovalResponseSchema,
    await request(
      `/review/runs/${encodeURIComponent(runId)}/approvals/${encodeURIComponent(requestId)}`,
      { method: "POST", body: answerApprovalRequestSchema.parse(body) },
    ),
  );
}

/**
 * Where the browser reads a file under a run's outputs: `path` is relative to
 * `/outputs/`, an output version's `path` and a file name. Images come back as images, anything
 * else as an attachment. 404: unreadable run or no such file.
 */
export const outputFileUrl = (runId: string, path: string) =>
  `/api/review/runs/${encodeURIComponent(runId)}/outputs/${path
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;

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

/**
 * A small picture of the run for lists and cards, made once from its first converted image
 * volume. 200 WebP; 204 while the run has none yet; 404: unreadable run; 503: no file storage.
 */
export const runThumbnailUrl = (runId: string) =>
  `/api/review/runs/${encodeURIComponent(runId)}/thumbnail`;

/** Inputs the caller may start a run on, newest first. */
export async function listInputs(): Promise<Input[]> {
  return (await read(listInputsResponseSchema, await request("/run/inputs"))).inputs;
}

/**
 * Creates an upload: a new input and a presigned URL per file (`@voluma/contracts/run`,
 * Uploads). PUT each file with `putUploadFile`, then call `completeUpload`. 403 for a
 * guest, 413 over the server's limits, 429 when the caller has too many uploads open.
 */
export async function createUpload(req: CreateUploadRequest): Promise<CreateUploadResponse> {
  return read(
    createUploadResponseSchema,
    await request("/run/inputs", { method: "POST", body: req }),
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
    const { missing } = await parse(completeUploadConflictSchema, await res.json(), res);
    throw new UploadIncompleteError(missing, res.url);
  }
  return read(inputSchema, res);
}

/** Drops an uncompleted upload and its stored files. 409 once it is completed. */
export async function cancelUpload(inputId: string): Promise<void> {
  checkResponse(
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
 * is told of a message that fails to parse (a `ContractError` when it doesn't match the schema)
 * or a handler that throws; a dropped connection is not an error.
 * `onClosed` fires when the stream is over for good, with why: `"ended"` when the server sent
 * every event of an ended run, `"refused"` when the browser gave up on it (a non-200 answer:
 * a 404, a sign-out, a server restarting; `EventSource` hides which, so refetch the run or call
 * `getMe` to tell). Returns the function that closes the stream.
 */
export function subscribe(
  runId: string,
  handlers: {
    onEvent: (event: RunEvent) => void;
    onError?: (error: unknown) => void;
    /** The stream will not reconnect: the run has ended, or the server refused it. */
    onClosed?: (why: "ended" | "refused") => void;
  },
  after = 0,
): () => void {
  const source = new EventSource(
    `/api/run/runs/${encodeURIComponent(runId)}/stream?after=${after}`,
  );
  // Messages are handled in order as they arrive, so a mismatch can't wait for the handler: it
  // is reported to `onError` at once, and the handler decides about leaving in the background.
  source.onmessage = (e) => {
    try {
      const parsed = matches(runEventSchema, JSON.parse(e.data), source.url, false);
      if (!parsed.ok) {
        void contractErrorHandler(parsed.error);
        throw parsed.error;
      }
      handlers.onEvent(parsed.value);
    } catch (error) {
      handlers.onError?.(error);
    }
  };
  // The run ended and every event has been sent; closing here skips the reconnect.
  source.addEventListener(END_EVENT, () => {
    source.close();
    handlers.onClosed?.("ended");
  });
  source.onerror = () => {
    if (source.readyState === EventSource.CLOSED) handlers.onClosed?.("refused");
  };
  return () => source.close();
}
