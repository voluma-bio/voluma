/**
 * Authentication for the whole API, at the composition root (index.ts is its only
 * caller, so there is no port). Two ways in:
 *  - `Authorization: Bearer <VOLUMA_API_TOKEN>`: the runner, principal `service`/`runner`;
 *    or `Bearer <VOLUMA_DEBUG_TOKEN>` (optional): agents debugging runs, principal
 *    `service`/`debug`, which only reads runs (domain.ts `requireReader`). When the header
 *    is present only the bearer counts; the cookie is never consulted.
 *  - the WorkOS AuthKit session cookie: a member of an allowed organization, principal
 *    `user` (its `labId` is that organization, its `scope` the organization's entry).
 * With `config.guest` set, a request with neither a session cookie nor a bearer but a
 * guest cookie is a guest: a `user` with account `visitor`, `labId` and `scope` from the
 * config, identified by a server-minted id in its own sealed cookie (no WorkOS call).
 * Only `POST /api/auth/guest` mints one; a GET never does. A session cookie that is
 * refused is cleared and answered 401, never turned into a guest; with `guest` null the
 * guest cookie is ignored and the request is a 401.
 * `createAuth` returns the pieces index.ts mounts on `/api/*`, in this order:
 *  1. `guards`: the bearer check and the CSRF rules. No I/O, so a forged request makes no
 *     WorkOS call.
 *  2. `sessionRoutes`: login, callback, password, logout and guest, the only writers of the session
 *     and guest cookies.
 *  3. `session`, then `requirePrincipal`: the cookie (else a guest cookie) becomes a user principal, and
 *     everything else without a principal is a 401. This is the only place that
 *     validates the cookie and refreshes an expired access token with WorkOS; the
 *     refreshed `Set-Cookie`s ride on the response (each its own header: AuthKit forbids
 *     comma-joining).
 *  4. `userRoutes` and the domains, which see a non-null principal (domain.ts).
 */

import { randomUUID } from "node:crypto";
import { type Me, passwordSignInRequestSchema } from "@voluma/contracts/auth";
import {
  AuthKitCore,
  CookieSessionStorage,
  configure,
  createAuthService,
  getConfigurationProvider,
  type HeadersBag,
  isPKCEVerifierCookieName,
  PKCEPayloadTooLargeError,
  selectStalePKCEVerifierCookieNames,
  sessionEncryption,
  TokenRefreshError,
  type User,
} from "@workos/authkit-session";
import {
  AuthenticationException,
  GenericServerException,
  OauthException,
  WorkOS,
} from "@workos-inc/node";
import { type Context, Hono } from "hono";
import { getCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import { timingSafeEqual } from "hono/utils/buffer";
import { serialize } from "hono/utils/cookie";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { type Principal, parseJson, requireUser, type Scope, type UserEnv } from "./domain";

export interface AuthConfig {
  clientId: string;
  apiKey: string;
  /** Seals the session cookie; at least 32 characters. */
  cookiePassword: string;
  /**
   * The organizations whose members may sign in, each with the data scope its members
   * get. The first `lab` entry is the organization the sign-in page is pinned to.
   */
  organizations: { id: string; scope: Scope }[];
  /**
   * Who a request with no credential is, or null for a sign-in wall. Guests belong to
   * `organizationId` and see what `scope` allows, as a member of it would.
   */
  guest: { organizationId: string; scope: Scope } | null;
  /** Where the browser reaches the app (no trailing slash). Never taken from `Host`. */
  appUrl: string;
  /** The runner's bearer token. */
  apiToken: string;
  /** A read-only bearer token for agents debugging runs (principal `debug`); null turns it off. */
  debugToken: string | null;
}

// `principal` is set by the first guard, then by `session`; null means no credential
// was accepted.
type RootEnv = { Variables: { principal: Principal | null } };

// Cookie name -> raw (still URL-encoded) value.
function parseCookies(request: Request) {
  const cookies = new Map<string, string>();
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq >= 0) cookies.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
  }
  return cookies;
}

// AuthKit's storage is abstract over the framework. Ours reads a Request's Cookie
// header and collects every Set-Cookie into the `string[]` it is given as the response.
class RequestStorage extends CookieSessionStorage<Request, string[]> {
  async getCookie(request: Request, name: string) {
    const raw = parseCookies(request).get(name);
    if (raw === undefined) return null;
    try {
      return decodeURIComponent(raw); // AuthKit's contract: the inverse of its encodeURIComponent
    } catch {
      return null;
    }
  }

  protected override async applyHeaders(sink: string[] | undefined, headers: HeadersBag) {
    if (!sink) return;
    sink.push(...[headers["Set-Cookie"] ?? []].flat());
    return { response: sink };
  }
}

// Session cookie lifetime. The refresh token, not this, bounds the session; a month
// keeps a lab member signed in across a holiday without a permanent cookie.
const COOKIE_MAX_AGE = 30 * 24 * 60 * 60;

// The guest cookie outlives any visit: a guest is a browser, and losing the cookie
// loses their work under `scope: "self"`.
const GUEST_MAX_AGE = 400 * 24 * 60 * 60;
const GUEST_ID_PREFIX = "guest_";

// Every WorkOS call is on a request path (refresh, revoke, code exchange), so it is
// bounded: one attempt, 3 s. The SDK's default is 4 attempts and 60 s each.
const WORKOS_TIMEOUT_MS = 3000;

// Refresh outcomes remembered per process (see `RefreshMemo`).
const MEMO_ENTRIES = 10_000;

// The sealed PKCE verifier cookie must stay under 4 KB. A returnTo that is a printable
// ASCII path of at most this many characters keeps it near 1.2 KB, so several pending
// verifiers still fit in one Cookie header.
const MAX_RETURN_TO = 512;

// A same-origin path (query and fragment included), or undefined. The URL parser
// percent-encodes control and non-ASCII characters, so the sealed JSON stays small.
function returnPath(raw: string | undefined) {
  if (raw === undefined) return undefined;
  const base = "https://placeholder.invalid";
  try {
    const url = new URL(raw, base);
    const path = `${url.pathname}${url.search}${url.hash}`;
    if (url.origin !== base || path.length > MAX_RETURN_TO || !/^[\x21-\x7e]*$/.test(path)) return;
    return path;
  } catch {
    return;
  }
}

// Whether a failed refresh means the session is over. Modelled on
// @workos-inc/node's CookieSession.refresh (classifyTerminalRefreshError, then
// classifyRetryableRefreshError, both unexported; re-diff them when bumping the pin):
// an OAuth or authentication error, or any other 4xx, ends the session. The status
// is checked first, because the SDK reports its own request timeout as an
// `OauthException` with status 408. 408, 429, 5xx, network errors, an HTML error page
// (`Error("Unexpected error")`) and anything unknown keep the cookie, so an outage
// does not sign people out (and, with the refresh memo, is never remembered as dead).
function isTerminalRefreshError(error: unknown) {
  if (!(error instanceof TokenRefreshError)) return false;
  const cause = error.cause;
  const status = (cause as { status?: number } | undefined)?.status;
  if (status === 408 || status === 429 || (status !== undefined && status >= 500)) return false;
  return (
    cause instanceof OauthException ||
    cause instanceof AuthenticationException ||
    (cause instanceof GenericServerException &&
      status !== undefined &&
      status >= 400 &&
      status < 500)
  );
}

type Refreshed = Awaited<ReturnType<AuthKitCore["validateAndRefresh"]>>;

// What a refresh token last got from WorkOS, so a client that replays a cookie (never
// storing the Set-Cookie) can't drive a WorkOS call per request. `Refreshed` holds until
// its access token expires; `dead` (terminal failure, sign-out, revoke) until the
// cookie's max age; `unavailable` (transient failure) for UNAVAILABLE_MS, so a replay
// during an outage or rate limit adds no load. `dead` is final: a refresh that was in
// flight when the session ended finishes later and must not bring it back. Keyed by the
// refresh token; a bounded LRU (a Map is insertion-ordered), so memory does not grow
// with the cookies seen.
type Remembered = { outcome: Refreshed | "dead" | "unavailable"; until: number };

// AuthKit's 429 Retry-After cap, so the memo does not outlast the rate limit it reports.
const UNAVAILABLE_MS = 10_000;

class RefreshMemo {
  private entries = new Map<string, Remembered>();

  get(refreshToken: string) {
    const entry = this.entries.get(refreshToken);
    if (!entry) return undefined;
    this.entries.delete(refreshToken);
    if (entry.until <= Date.now()) return undefined;
    this.entries.set(refreshToken, entry);
    return entry.outcome;
  }

  // The only way to mark a session over.
  dead(refreshToken: string) {
    this.put(refreshToken, { outcome: "dead", until: Date.now() + COOKIE_MAX_AGE * 1000 });
  }

  refreshed(refreshToken: string, result: Refreshed) {
    this.put(refreshToken, { outcome: result, until: (result.claims.exp ?? 0) * 1000 });
  }

  unavailable(refreshToken: string) {
    this.put(refreshToken, { outcome: "unavailable", until: Date.now() + UNAVAILABLE_MS });
  }

  private put(refreshToken: string, next: Remembered) {
    const current = this.entries.get(refreshToken);
    if (current?.outcome === "dead" && next.outcome !== "dead" && current.until > Date.now()) {
      return;
    }
    this.entries.delete(refreshToken);
    this.entries.set(refreshToken, next);
    if (this.entries.size > MEMO_ENTRIES) {
      this.entries.delete(this.entries.keys().next().value as string);
    }
  }
}

type SessionRef = { id: string; refreshToken: string };

function userPrincipal(
  user: User,
  labId: string,
  scope: Scope,
): Extract<Principal, { account: "member" }> {
  return {
    kind: "user",
    userId: user.id,
    account: "member",
    email: user.email,
    name: [user.firstName, user.lastName].filter(Boolean).join(" ") || null,
    labId,
    scope,
  };
}

function guestPrincipal(
  userId: string,
  guest: NonNullable<AuthConfig["guest"]>,
): Extract<Principal, { account: "visitor" }> {
  return {
    kind: "user",
    userId,
    account: "visitor",
    name: null,
    labId: guest.organizationId,
    scope: guest.scope,
  };
}

/** What `/me` and the sign-in routes tell the browser about a user. */
function meOf(user: Extract<Principal, { kind: "user" }>): Me {
  const { userId, name, labId } = user;
  return user.account === "member"
    ? { kind: "member", userId, email: user.email, name, labId }
    : { kind: "visitor", userId, name, labId };
}

function setCookies(c: Context, cookies: string[]) {
  for (const cookie of cookies) c.header("Set-Cookie", cookie, { append: true });
}

/**
 * The header WorkOS gets as the caller's address: one the host's proxy sets and a client cannot
 * override. Render's edge (Cloudflare) overwrites `true-client-ip` with the caller's address; it
 * passes a client's own `x-real-ip` through unchanged and keeps a client's `x-forwarded-for`
 * entries. Checked on 2026-10-30 with forged values against a Render service in Virginia.
 */
const CLIENT_IP_HEADER = "true-client-ip";

/** Failed password sign-ins allowed per email in each window. */
const PASSWORD_ATTEMPTS = 10;
const PASSWORD_WINDOW_MS = 15 * 60 * 1000;

export function createAuth(config: AuthConfig) {
  const appOrigin = new URL(config.appUrl).origin;
  const scopes = new Map(config.organizations.map((org) => [org.id, org.scope]));
  const signInOrganizationId = config.organizations.find((org) => org.scope === "lab")?.id;
  if (!signInOrganizationId) throw new Error("createAuth needs a lab organization");
  if (config.guest && scopes.has(config.guest.organizationId)) {
    throw new Error("The guest organization must not be one that members sign in to");
  }
  // __Host- needs Secure, Path=/ and no Domain, so a sibling subdomain can't plant or
  // shadow the cookie. AuthKit sets Secure when the redirect URI is https.
  const cookieName = appOrigin.startsWith("https:") ? "__Host-wos-session" : "wos-session";
  // An empty value source: AuthKit would otherwise prefer WORKOS_* from process.env
  // over this config, and only index.ts reads env.
  configure(
    {
      clientId: config.clientId,
      apiKey: config.apiKey,
      cookiePassword: config.cookiePassword,
      redirectUri: `${config.appUrl}/api/auth/callback`,
      cookieName,
      cookieMaxAge: COOKIE_MAX_AGE,
      cookieSameSite: "lax",
    },
    () => undefined,
  );
  const authkit = createAuthService<Request, string[]>({
    sessionStorageFactory: (c) => new RequestStorage(c),
    clientFactory: () =>
      new WorkOS({
        apiKey: config.apiKey,
        clientId: config.clientId,
        timeout: WORKOS_TIMEOUT_MS,
        maxRetries: 0,
      }),
  });
  const workos = authkit.getWorkOS();
  // Keys are kept for the process lifetime (`cacheMaxAge: Infinity`; jose defaults are a 5 s
  // timeout and a 10 min cache). The reason is outages: with a 10 min cache, the first
  // verification after the cache lapses during a WorkOS outage fails for every valid token,
  // each then refreshes and gets 503. An unknown `kid` still reloads, behind jose's 30 s
  // cooldown, so rotation works. The timeout is the same 3 s as every WorkOS call.
  const jwks = createRemoteJWKSet(new URL(workos.userManagement.getJwksUrl(config.clientId)), {
    timeoutDuration: WORKOS_TIMEOUT_MS,
    cacheMaxAge: Number.POSITIVE_INFINITY,
  });
  // The AuthKit layer under `withAuth`, which swallows the refresh error. One refresh per
  // request goes through here, so its failures are typed and concurrent refreshes of one
  // cookie share a single WorkOS call. AuthKit retries a 429 once after the Retry-After
  // (at most 10 s), so a rate-limited refresh is two calls; it is left on. `verifyToken`
  // is overridden to use `jwks`; `override` fails the typecheck if an upgrade removes it,
  // but re-check that `validateAndRefresh` still calls it when bumping the pin.
  class Core extends AuthKitCore {
    override async verifyToken(token: string) {
      try {
        await jwtVerify(token, jwks);
        return true;
      } catch {
        return false;
      }
    }
  }
  const core = new Core(getConfigurationProvider().getConfig(), workos, sessionEncryption);
  const memo = new RefreshMemo();
  // Like the session cookie, __Host- on https. The prefix is in the name itself:
  // `serialize` doesn't apply Hono's `prefix` option, so read and write use this name.
  const https = appOrigin.startsWith("https:");
  const guestCookieName = https ? "__Host-voluma-guest" : "voluma-guest";

  // Clears the session cookie and every pending PKCE verifier on the request, so
  // sign-out and refusals leave no AuthKit cookie behind.
  async function clearSessionCookies(request: Request, sink: string[]) {
    await authkit.clearSession(sink);
    for (const name of parseCookies(request).keys()) {
      if (isPKCEVerifierCookieName(name)) {
        await authkit.clearPendingVerifierByName(sink, { cookieName: name });
      }
    }
  }

  // Ends WorkOS sessions server-side and marks their refresh tokens dead in the memo (the
  // guarantee is in .context/CONTEXT.md, Authentication). Never throws:
  // callers clear the cookie whatever happens here.
  async function revokeSessions(sessions: (SessionRef | null)[]) {
    await Promise.all(
      sessions.map(async (ref) => {
        if (ref === null) return;
        memo.dead(ref.refreshToken);
        try {
          await workos.userManagement.revokeSession({ sessionId: ref.id });
        } catch (error) {
          const { name, status } = error as { name?: string; status?: number };
          console.error("WorkOS session revoke failed:", name, status);
        }
      }),
    );
  }

  // The session id (`sid`) and refresh token of the request's cookie, read without
  // refreshing (it works on an expired token, and while WorkOS is unreachable), or null
  // for no readable cookie.
  async function requestSession(request: Request): Promise<SessionRef | null> {
    try {
      const session = await authkit.getSession(request);
      const id = session ? core.parseTokenClaims(session.accessToken).sid : undefined;
      return session && id ? { id, refreshToken: session.refreshToken } : null;
    } catch {
      return null;
    }
  }

  // The principal for a request's session cookie; "none" when it presented no cookie;
  // "refused" when it presented one that is not (or no longer) good, which is cleared;
  // "unavailable" when a refresh failed transiently. Cookies to set go to `sink`.
  // A dead cookie is cleared and remembered as dead, so a replay of it costs no WorkOS
  // call; a refreshed session is remembered until its access token expires. Any other
  // WorkOS failure keeps the cookie, is remembered briefly, and the caller answers 503, so
  // an outage does not sign people out.
  async function userFromCookie(request: Request, sink: string[]) {
    let session: Awaited<ReturnType<typeof authkit.getSession>>;
    try {
      session = await authkit.getSession(request);
    } catch {
      await clearSessionCookies(request, sink);
      return "refused" as const;
    }
    if (session === null) return "none" as const;
    const remembered = memo.get(session.refreshToken);
    if (remembered === "dead") {
      await clearSessionCookies(request, sink);
      return "refused" as const;
    }
    if (remembered === "unavailable") return remembered;
    let result: Refreshed;
    if (remembered) {
      result = { ...remembered, refreshed: false };
    } else {
      try {
        result = await core.validateAndRefresh(session);
      } catch (error) {
        if (isTerminalRefreshError(error)) {
          memo.dead(session.refreshToken);
          await clearSessionCookies(request, sink);
          return "refused" as const;
        }
        console.error("session refresh failed; cookie kept", error);
        memo.unavailable(session.refreshToken);
        return "unavailable" as const;
      }
      if (result.refreshed) memo.refreshed(session.refreshToken, result);
    }
    // The enforcement point for membership, bounded by the access-token lifetime.
    const orgId = result.claims.org_id;
    const scope = orgId === undefined ? undefined : scopes.get(orgId);
    if (orgId === undefined || scope === undefined) {
      await clearSessionCookies(request, sink);
      return "refused" as const;
    }
    if (result.refreshed)
      await authkit.saveSession(sink, await core.encryptSession(result.session));
    return userPrincipal(result.session.user, orgId, scope);
  }

  // The guest for a request, or null for no valid guest cookie (absent, garbled, forged
  // or sealed under another password).
  async function guestIdFromCookie(c: Context) {
    const sealed = getCookie(c, guestCookieName);
    if (!sealed) return null;
    try {
      const { id } = await sessionEncryption.unsealData<{ id?: unknown }>(sealed, {
        password: config.cookiePassword,
      });
      return typeof id === "string" && id.startsWith(GUEST_ID_PREFIX) ? id : null;
    } catch {
      return null;
    }
  }

  // Sets a new guest identity's cookie in `sink` and returns its id.
  async function mintGuest(sink: string[]) {
    const id = `${GUEST_ID_PREFIX}${randomUUID()}`;
    sink.push(
      serialize(
        guestCookieName,
        await sessionEncryption.sealData({ id }, { password: config.cookiePassword }),
        {
          httpOnly: true,
          sameSite: "Lax",
          maxAge: GUEST_MAX_AGE,
          secure: https,
          path: "/",
        },
      ),
    );
    return id;
  }

  const bearer = createMiddleware<RootEnv>(async (c, next) => {
    const authorization = c.req.header("authorization");
    const token = authorization && /^Bearer +(.+)$/i.exec(authorization)?.[1];
    const runner = token && (await timingSafeEqual(token, config.apiToken));
    const debug =
      !runner && token && config.debugToken && (await timingSafeEqual(token, config.debugToken));
    c.set(
      "principal",
      runner
        ? { kind: "service", name: "runner" }
        : debug
          ? { kind: "service", name: "debug" }
          : null,
    );
    return next();
  });

  // The origin and content-type rules for requests that authenticate by cookie.
  // SameSite=Lax is same-site, not same-origin (every *.voluma.bio host is same-site),
  // so state-changing requests must come from the app's origin. Nothing upgrades to
  // WebSockets; a route that ever does must check `Origin` on the upgrade here too.
  // Service (bearer) requests carry no ambient credential and are exempt; a request
  // with some other Authorization header has no principal and is checked like any other.
  const csrf = createMiddleware<RootEnv>(async (c, next) => {
    const { method, headers } = c.req.raw;
    const mutates = method !== "GET" && method !== "HEAD";
    if (c.get("principal")?.kind === "service" || !mutates) return next();
    const site = headers.get("sec-fetch-site");
    if (headers.get("origin") !== appOrigin || (site !== null && site !== "same-origin")) {
      return c.json(
        { error: "This request didn't come from the Voluma app. Reload the page and try again." },
        403,
      );
    }
    if (!/^application\/json\s*(;|$)/i.test(headers.get("content-type") ?? "")) {
      return c.json({ error: "content-type must be application/json" }, 415);
    }
    return next();
  });

  const session = createMiddleware<RootEnv>(async (c, next) => {
    if (c.req.header("authorization") !== undefined) return next(); // the bearer decided
    const cookies: string[] = [];
    const member = await userFromCookie(c.req.raw, cookies);
    if (member === "unavailable") return c.json({ error: "auth unavailable" }, 503);
    let principal: Principal | null = null;
    if (member === "none") {
      const id = config.guest && (await guestIdFromCookie(c));
      principal = id && config.guest ? guestPrincipal(id, config.guest) : null;
    } else if (member !== "refused") {
      principal = member;
    }
    c.set("principal", principal);
    await next(); // a refused cookie's clear rides on the 401 from requirePrincipal
    for (const cookie of cookies) c.res.headers.append("Set-Cookie", cookie);
  });

  // 401 for every /api path past the auth routes that has no principal.
  const requirePrincipal = createMiddleware<RootEnv>(async (c, next) =>
    c.get("principal") === null ? c.json({ error: "unauthorized" }, 401) : next(),
  );

  // The routes that write the session cookie. They are mounted before `session`, so no
  // refreshed or clearing cookie of its own can overwrite theirs, and login and callback
  // (PKCE and state, not the session) make no refresh round trip.
  const sessionRoutes = new Hono<RootEnv>();

  sessionRoutes.get("/login", async (c) => {
    const cookies: string[] = [];
    const start = (returnPathname: string | undefined) =>
      authkit.createSignIn(cookies, { returnPathname, organizationId: signInOrganizationId });
    let url: string;
    try {
      ({ url } = await start(returnPath(c.req.query("returnTo"))));
    } catch (error) {
      if (!(error instanceof PKCEPayloadTooLargeError)) throw error;
      cookies.length = 0;
      ({ url } = await start(undefined));
    }
    // Verifier cookies are per flow and accumulate; evict the stale ones before the
    // Cookie header outgrows the server's limit.
    const keep = cookies[0]?.split("=")[0] ?? "";
    for (const name of selectStalePKCEVerifierCookieNames(parseCookies(c.req.raw).keys(), {
      keep,
    })) {
      await authkit.clearPendingVerifierByName(cookies, { cookieName: name });
    }
    setCookies(c, cookies);
    return c.redirect(url);
  });

  sessionRoutes.get("/callback", async (c) => {
    const code = c.req.query("code");
    const state = c.req.query("state");
    if (!code) return c.redirect("/?signin=failed");
    const cookies: string[] = [];
    let result: Awaited<ReturnType<typeof authkit.handleCallback>>;
    try {
      result = await authkit.handleCallback(c.req.raw, cookies, { code, state });
    } catch (error) {
      // A reused or expired callback link (bad state, spent code) lands here.
      console.error("sign-in callback failed:", error);
      setCookies(c, cookies); // the verifier clear
      return c.redirect("/?signin=failed");
    }
    // Signing in over an existing session replaces its cookie; end the old session too.
    const newSid = core.parseTokenClaims(result.authResponse.accessToken).sid;
    const created = newSid ? { id: newSid, refreshToken: result.authResponse.refreshToken } : null;
    const old = await requestSession(c.req.raw);
    const stale = old?.id === created?.id ? null : old;
    if (scopes.has(result.authResponse.organizationId ?? "")) {
      await revokeSessions([stale]);
      setCookies(c, cookies);
      return c.redirect(`${config.appUrl}${result.returnPathname}`);
    }
    // Not in an allowed organization: handleCallback has already sealed a session. Keep none of it,
    // and end it at WorkOS so no usable session survives.
    await revokeSessions([created, stale]);
    cookies.length = 0;
    await clearSessionCookies(c.req.raw, cookies);
    setCookies(c, cookies);
    return c.redirect(`${config.appUrl}/?signin=not-a-member`);
  });

  // Password sign-in for scripts (the scan upload CLI); a browser goes through /login. The
  // same membership rule as the callback. Behind the CSRF guard like every POST, so another
  // site can't sign a browser in as someone else. Failed attempts are counted per email
  // here (in memory: one API replica), and WorkOS gets the caller's address to limit too.
  // The CLI keeps each response's Set-Cookie: WorkOS rotates the refresh token.
  const failedSignIns = new Map<string, { count: number; until: number }>();
  sessionRoutes.post("/password", async (c) => {
    const { email, password } = await parseJson(c, passwordSignInRequestSchema);
    const key = email.trim().toLowerCase();
    const now = Date.now();
    for (const [k, v] of failedSignIns) if (v.until <= now) failedSignIns.delete(k);
    // Counted before the WorkOS call, so parallel guesses can't all pass the check; a
    // success gives the attempt back.
    const tries = failedSignIns.get(key) ?? { count: 0, until: now + PASSWORD_WINDOW_MS };
    if (tries.count >= PASSWORD_ATTEMPTS) return c.json({ error: "too many attempts" }, 429);
    tries.count++;
    failedSignIns.set(key, tries);
    let auth: Awaited<ReturnType<typeof workos.userManagement.authenticateWithPassword>>;
    try {
      auth = await workos.userManagement.authenticateWithPassword({
        clientId: config.clientId,
        email,
        password,
        ipAddress: c.req.header(CLIENT_IP_HEADER),
        userAgent: c.req.header("user-agent"),
      });
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (status !== undefined && status >= 400 && status < 500 && status !== 429) {
        return c.json({ error: "sign-in refused" }, 401);
      }
      // Not the caller's fault (a WorkOS limit or outage): the attempt doesn't count.
      tries.count--;
      if (status === 429) return c.json({ error: "too many attempts" }, 429);
      throw error;
    }
    tries.count--;
    const sid = core.parseTokenClaims(auth.accessToken).sid;
    const scope = scopes.get(auth.organizationId ?? "");
    if (!scope || !auth.organizationId) {
      await revokeSessions([sid ? { id: sid, refreshToken: auth.refreshToken } : null]);
      return c.json({ error: "not-a-member" }, 403);
    }
    const cookies: string[] = [];
    await authkit.saveSession(
      cookies,
      await core.encryptSession({
        accessToken: auth.accessToken,
        refreshToken: auth.refreshToken,
        user: auth.user,
        impersonator: auth.impersonator,
      }),
    );
    setCookies(c, cookies);
    return c.json(meOf(userPrincipal(auth.user, auth.organizationId, scope)));
  });

  sessionRoutes.post("/logout", async (c) => {
    // End the WorkOS session here, not only in the browser. What a copy of the cookie
    // still gets afterwards: .context/CONTEXT.md, Authentication.
    const current = await requestSession(c.req.raw);
    await revokeSessions([current]);
    // The browser still visits logoutUrl, which ends WorkOS's own AuthKit session.
    const logoutUrl = current
      ? workos.userManagement.getLogoutUrl({ sessionId: current.id, returnTo: `${config.appUrl}/` })
      : "/";
    const cookies: string[] = [];
    await clearSessionCookies(c.req.raw, cookies);
    setCookies(c, cookies);
    return c.json({ logoutUrl });
  });

  // The only place a guest is minted: an explicit same-origin POST (behind the CSRF
  // guard), so a cross-site GET or a 404 mints nothing. It answers like /me. A browser
  // that already holds a guest cookie keeps its id.
  sessionRoutes.post("/guest", async (c) => {
    if (!config.guest) return c.json({ error: "not found" }, 404);
    const cookies: string[] = [];
    const id = (await guestIdFromCookie(c)) ?? (await mintGuest(cookies));
    setCookies(c, cookies);
    return c.json(meOf(guestPrincipal(id, config.guest)));
  });

  const userRoutes = new Hono<UserEnv>().use(requireUser);

  userRoutes.get("/me", (c) => c.json(meOf(c.var.user)));

  return {
    guards: [bearer, csrf] as const,
    sessionRoutes,
    session: [session, requirePrincipal] as const,
    userRoutes,
  };
}
