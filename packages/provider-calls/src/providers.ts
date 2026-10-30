/**
 * What the gateway lets through to each provider: the base URL, how our key is sent, and the
 * exact method and path pairs (everything else is a 403). A path is matched whole, after
 * rejecting anything that would normalize to another path. Anthropic's and OpenAI's Files and
 * Batches APIs stay closed because every run shares our account.
 */
import { PROVIDER_NAMES, type Provider } from "./token";

export type RouteKind =
  /** A model call: its model must have a price in Pi's catalog (or be in `models`). */
  | "model"
  /** Meta's upload: the reply's file id is recorded on the row. */
  | "file-upload"
  /** Meta's delete: only for a file id this run uploaded. */
  | "file-delete";

export type Route = {
  method: "POST" | "DELETE";
  /** Exact path; for `file-delete`, the prefix before the file id. */
  path: string;
  kind: RouteKind;
  /** The only models this route accepts; absent: any model with a price. */
  models?: readonly string[];
  /**
   * Answer a call that sends `Accept: text/event-stream` with 200 and the stream's headers at
   * once, reporting the upstream's outcome in the stream (see the gateway's CONTEXT.md). Only
   * for callers that understand the `gateway-error` event; the others keep real statuses.
   */
  earlyStream?: boolean;
};

export type ProviderDef = {
  /**
   * Whether the gateway admits any route. Anthropic and OpenAI are off until the runner's model
   * calls move onto the gateway; the gate for turning them on is in `apps/gateway/.context/TODO.md`.
   */
  enabled: boolean;
  baseUrl: string;
  /** The headers that carry our key (the caller's own auth headers are stripped). */
  auth(key: string): Record<string, string>;
  routes: readonly Route[];
};

const bearer = (key: string) => ({ authorization: `Bearer ${key}` });

export const PROVIDERS: Record<Provider, ProviderDef> = {
  meta: {
    enabled: true,
    baseUrl: "https://api.meta.ai",
    auth: bearer,
    routes: [
      { method: "POST", path: "/v1/files", kind: "file-upload" },
      {
        method: "POST",
        path: "/v1/responses",
        kind: "model",
        models: ["sam-3.1"],
        earlyStream: true,
      },
      { method: "DELETE", path: "/v1/files/", kind: "file-delete" },
    ],
  },
  anthropic: {
    enabled: false,
    baseUrl: "https://api.anthropic.com",
    auth: (key) => ({ "x-api-key": key }),
    routes: [{ method: "POST", path: "/v1/messages", kind: "model" }],
  },
  openai: {
    enabled: false,
    baseUrl: "https://api.openai.com",
    auth: bearer,
    routes: [{ method: "POST", path: "/v1/responses", kind: "model" }],
  },
};

export const isProvider = (name: string): name is Provider =>
  (PROVIDER_NAMES as readonly string[]).includes(name);

/** A path that is not already in normal form (encoded bytes, dot segments, empty segments). */
const ABNORMAL = /%|\\|\/\.{1,2}(\/|$)|\/\//;
const FILE_ID = /^[A-Za-z0-9_-]{1,128}$/;

export type Matched = { route: Route; fileId?: string };

/** The route a request may use, or null: a 403. `path` has no query string. */
export function matchRoute(provider: Provider, method: string, path: string): Matched | null {
  if (!PROVIDERS[provider].enabled || !path.startsWith("/") || ABNORMAL.test(path)) return null;
  for (const route of PROVIDERS[provider].routes) {
    if (route.method !== method) continue;
    if (route.kind !== "file-delete") {
      if (path === route.path) return { route };
      continue;
    }
    const id = path.startsWith(route.path) ? path.slice(route.path.length) : "";
    if (FILE_ID.test(id)) return { route, fileId: id };
  }
  return null;
}
