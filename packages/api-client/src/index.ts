/**
 * Typed client for apps/api over the contracts. Web features call the API only
 * through here. Requests are same-origin; a 401 on any call except `getMe`
 * emits "signed out" so the shell can show the sign-in screen.
 */
import { logoutResponseSchema, type Me, meResponseSchema } from "@voluma/contracts/auth";
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
import { type StreamMessage, streamMessageSchema } from "@voluma/contracts/stream";

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
 * Opens a run's live stream (`@voluma/contracts/stream`): `onMessage` gets each message
 * in order. `EventSource` reconnects by itself and resumes from the last event's `id`; the
 * new snapshot replaces live state. `after` is the highest `seq` the caller already holds,
 * for the first connect only. `onError` is told of a message that fails to parse; a dropped
 * connection is not an error, and neither is a 401, which `EventSource` cannot report.
 * Returns the function that closes the stream.
 */
export function subscribe(
  runId: string,
  handlers: { onMessage: (message: StreamMessage) => void; onError?: (error: unknown) => void },
  after = 0,
): () => void {
  const source = new EventSource(
    `/api/run/runs/${encodeURIComponent(runId)}/stream?after=${after}`,
  );
  source.onmessage = (e) => {
    try {
      handlers.onMessage(streamMessageSchema.parse(JSON.parse(e.data)));
    } catch (error) {
      handlers.onError?.(error);
    }
  };
  return () => source.close();
}
