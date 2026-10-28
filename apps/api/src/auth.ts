/**
 * Authentication for the whole API, at the composition root (index.ts is its only
 * caller, so there is no port). Two ways in:
 *  - `Authorization: Bearer <VOLUMA_API_TOKEN>`: the runner, principal `service`. When
 *    the header is present only the bearer counts; the cookie is never consulted.
 *  - the WorkOS AuthKit session cookie: a member of an allowed organization, principal
 *    `user` (its `labId` is that organization, its `scope` the organization's entry).
 * With `config.guest` set, a request with neither is a guest: a `user` with account
 * `visitor`, `labId` and `scope` from the config, identified by a server-minted id in
 * its own sealed cookie (no WorkOS call). A member session always wins over the guest
 * cookie; with `guest` null the guest cookie is ignored and the request is a 401.
 * `createAuth` returns the pieces index.ts mounts on `/api/*`, in this order:
 *  1. `guards`: the bearer check and the CSRF rules. No I/O, so a forged request makes no
 *     WorkOS call.
 *  2. `sessionRoutes`: login, callback and logout, the only writers of the session cookie.
 *  3. `session`, then `requirePrincipal`: the cookie (else a guest) becomes a user principal, and
 *     everything else without a principal is a 401. This is the only place that
 *     validates the cookie and refreshes an expired access token with WorkOS; the
 *     refreshed `Set-Cookie`s ride on the response (each its own header: AuthKit forbids
 *     comma-joining).
 *  4. `userRoutes` and the domains, which see a non-null principal (domain.ts).
 */

import { createHash, randomUUID } from "node:crypto";
import { getConnInfo } from "@hono/node-server/conninfo";
import type { Me } from "@voluma/contracts/auth";
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
import { getCookie, setCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import { timingSafeEqual } from "hono/utils/buffer";
import { createRemoteJWKSet } from "jose";
import { type Principal, requireUser, type Scope, type UserEnv } from "./domain";

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

// New guest identities one client address may mint per window (see `MintLimit`).
const GUESTS_PER_WINDOW = 20;
const GUEST_WINDOW_MS = 60 * 60 * 1000;
const MINT_ENTRIES = 10_000;

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
// its access token expires; `dead` (terminal failure) until the cookie's max age.
// Transient failures are never stored. Keyed by a hash of the refresh token; a bounded
// LRU (a Map is insertion-ordered), so memory does not grow with the cookies seen.
type Remembered = { outcome: Refreshed | "dead"; until: number };

class RefreshMemo {
  private entries = new Map<string, Remembered>();

  private key(refreshToken: string) {
    return createHash("sha256").update(refreshToken).digest("base64");
  }

  get(refreshToken: string) {
    const key = this.key(refreshToken);
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    if (entry.until <= Date.now()) return undefined;
    this.entries.set(key, entry);
    return entry.outcome;
  }

  // Remembers a session that is over (terminal refresh failure, sign-out, revoke).
  dead(refreshToken: string) {
    this.set(refreshToken, "dead", Date.now() + COOKIE_MAX_AGE * 1000);
  }

  set(refreshToken: string, outcome: Refreshed | "dead", until: number) {
    const key = this.key(refreshToken);
    this.entries.delete(key);
    this.entries.set(key, { outcome, until });
    if (this.entries.size > MEMO_ENTRIES) {
      this.entries.delete(this.entries.keys().next().value as string);
    }
  }
}

// A fixed window of guest mints per client address. In-process, so a restart or a second
// instance resets it; it bounds a script, not a determined attacker. A bounded LRU like
// `RefreshMemo`.
class MintLimit {
  private windows = new Map<string, { start: number; count: number }>();

  /** Counts a mint for `address`; false when it is over the limit. */
  allow(address: string) {
    const now = Date.now();
    const found = this.windows.get(address);
    const window = found && now - found.start < GUEST_WINDOW_MS ? found : { start: now, count: 0 };
    this.windows.delete(address);
    this.windows.set(address, window);
    if (this.windows.size > MINT_ENTRIES) {
      this.windows.delete(this.windows.keys().next().value as string);
    }
    if (window.count >= GUESTS_PER_WINDOW) return false;
    window.count += 1;
    return true;
  }
}

type SessionRef = { id: string; refreshToken: string };

function userPrincipal(user: User, labId: string, scope: Scope): Principal {
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

function guestPrincipal(userId: string, guest: NonNullable<AuthConfig["guest"]>): Principal {
  return {
    kind: "user",
    userId,
    account: "visitor",
    email: null,
    name: null,
    labId: guest.organizationId,
    scope: guest.scope,
  };
}

// Attach Set-Cookie headers to the response Hono is about to build.
function setCookies(c: Context, cookies: string[]) {
  for (const cookie of cookies) c.header("Set-Cookie", cookie, { append: true });
}

export function createAuth(config: AuthConfig) {
  const appOrigin = new URL(config.appUrl).origin;
  const scopes = new Map(config.organizations.map((org) => [org.id, org.scope]));
  const signInOrganizationId = config.organizations.find((org) => org.scope === "lab")?.id;
  if (!signInOrganizationId) throw new Error("createAuth needs a lab organization");
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
  // The AuthKit layer under `withAuth`, which swallows the refresh error. One refresh per
  // request goes through here, so its failures are typed and concurrent refreshes of one
  // cookie share a single WorkOS call. AuthKit retries a 429 once after the Retry-After
  // (at most 10 s), so a rate-limited refresh is two calls; it is left on.
  const core = new AuthKitCore(getConfigurationProvider().getConfig(), workos, sessionEncryption);
  // Replaces AuthKitCore's `getPublicKey` (jose defaults: 5 s timeout, 10 min cache, so a
  // cold process in an outage spends 5 s on the key set before the refresh). Same 3 s
  // bound as every WorkOS call, and keys are kept for the process lifetime; an unknown
  // `kid` still reloads, behind jose's 30 s cooldown, so rotation works. Re-check
  // `getPublicKey` in @workos/authkit-session when bumping the pin.
  const jwks = createRemoteJWKSet(new URL(workos.userManagement.getJwksUrl(config.clientId)), {
    timeoutDuration: WORKOS_TIMEOUT_MS,
    cacheMaxAge: Number.POSITIVE_INFINITY,
  });
  (core as unknown as { getPublicKey: () => typeof jwks }).getPublicKey = () => jwks;
  const memo = new RefreshMemo();
  const mintLimit = new MintLimit();
  // Like the session cookie, __Host- on https. Hono enforces Secure and Path=/ for it.
  const https = appOrigin.startsWith("https:");
  const guestCookieName = "voluma-guest";

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

  // Ends WorkOS sessions server-side, so a copy of a sealed cookie dies with them at its
  // next refresh (refresh tokens are not rotated on use), and marks their refresh tokens
  // dead in the memo, so a copy is not served a remembered session either. Never throws:
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

  // The principal for a request's session cookie, or null; "unavailable" when a refresh
  // failed transiently. Cookies to set go to `sink`.
  // A dead cookie is cleared and remembered as dead, so a replay of it costs no WorkOS
  // call; a refreshed session is remembered until its access token expires. Any other
  // WorkOS failure keeps the cookie and is not remembered, and the caller answers 503, so
  // an outage does not sign people out.
  async function userFromCookie(request: Request, sink: string[]) {
    let session: Awaited<ReturnType<typeof authkit.getSession>>;
    try {
      session = await authkit.getSession(request);
    } catch {
      await clearSessionCookies(request, sink);
      return null;
    }
    if (session === null) return null;
    const remembered = memo.get(session.refreshToken);
    if (remembered === "dead") {
      await clearSessionCookies(request, sink);
      return null;
    }
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
          return null;
        }
        console.error("session refresh failed; cookie kept", error);
        return "unavailable" as const;
      }
      if (result.refreshed) {
        memo.set(session.refreshToken, result, (result.claims.exp ?? 0) * 1000);
      }
    }
    // The enforcement point for membership, bounded by the access-token lifetime.
    const orgId = result.claims.org_id;
    const scope = orgId === undefined ? undefined : scopes.get(orgId);
    if (orgId === undefined || scope === undefined) {
      await clearSessionCookies(request, sink);
      return null;
    }
    if (result.refreshed)
      await authkit.saveSession(sink, await core.encryptSession(result.session));
    return userPrincipal(result.session.user, orgId, scope);
  }

  // The guest for a request, or null for no valid guest cookie (absent, garbled, forged
  // or sealed under another password).
  async function guestIdFromCookie(c: Context) {
    const sealed = getCookie(c, guestCookieName, https ? "host" : undefined);
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

  // The client address for the mint limit: X-Real-IP, which Railway's edge always
  // overwrites (X-Forwarded-For has no documented guarantee: its first entry was
  // spoofable in 2024); the socket address without it, as in local dev.
  function clientAddress(c: Context) {
    return c.req.header("x-real-ip") || getConnInfo(c).remote.address || "unknown";
  }

  // The guest principal for a request with no member session: its cookie's, else a new
  // one (cookie set on the response), or null when the address is over the mint limit.
  async function guestFrom(c: Context, guest: NonNullable<AuthConfig["guest"]>) {
    const existing = await guestIdFromCookie(c);
    if (existing) return guestPrincipal(existing, guest);
    if (!mintLimit.allow(clientAddress(c))) return null;
    const id = `${GUEST_ID_PREFIX}${randomUUID()}`;
    setCookie(
      c,
      guestCookieName,
      await sessionEncryption.sealData({ id }, { password: config.cookiePassword }),
      {
        httpOnly: true,
        sameSite: "Lax",
        maxAge: GUEST_MAX_AGE,
        secure: https,
        path: "/",
        prefix: https ? "host" : undefined,
      },
    );
    return guestPrincipal(id, guest);
  }

  const bearer = createMiddleware<RootEnv>(async (c, next) => {
    const authorization = c.req.header("authorization");
    const token = authorization && /^Bearer +(.+)$/i.exec(authorization)?.[1];
    const ok = token && (await timingSafeEqual(token, config.apiToken));
    c.set("principal", ok ? { kind: "service", name: "runner" } : null);
    return next();
  });

  // The origin and content-type rules for requests that authenticate by cookie.
  // SameSite=Lax is same-site, not same-origin (every *.voluma.bio host is same-site),
  // so state-changing requests and WebSocket upgrades must come from the app's origin.
  // Service (bearer) requests carry no ambient credential and are exempt; a request
  // with some other Authorization header has no principal and is checked like any other.
  const csrf = createMiddleware<RootEnv>(async (c, next) => {
    const { method, headers } = c.req.raw;
    const mutates = method !== "GET" && method !== "HEAD";
    const upgrade = headers.get("upgrade")?.toLowerCase() === "websocket";
    if (c.get("principal")?.kind === "service" || !(mutates || upgrade)) return next();
    const site = headers.get("sec-fetch-site");
    if (headers.get("origin") !== appOrigin || (site !== null && site !== "same-origin")) {
      return c.json({ error: "forbidden origin" }, 403);
    }
    if (mutates && !/^application\/json\s*(;|$)/i.test(headers.get("content-type") ?? "")) {
      return c.json({ error: "content-type must be application/json" }, 415);
    }
    return next();
  });

  const session = createMiddleware<RootEnv>(async (c, next) => {
    if (c.req.header("authorization") !== undefined) return next(); // the bearer decided
    const cookies: string[] = [];
    let principal = await userFromCookie(c.req.raw, cookies);
    if (principal === "unavailable") return c.json({ error: "auth unavailable" }, 503);
    if (principal === null && config.guest) {
      principal = await guestFrom(c, config.guest);
      if (principal === null) return c.json({ error: "too many new guests" }, 429);
    }
    c.set("principal", principal);
    await next();
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

  sessionRoutes.post("/logout", async (c) => {
    // End the WorkOS session here, not only in the browser. A copy of the sealed cookie
    // stops working at its next refresh; until then its access token (5 min on staging)
    // is still checked locally and answers 200.
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

  const userRoutes = new Hono<UserEnv>().use(requireUser);

  userRoutes.get("/me", (c) => {
    const { userId, account, email, name, labId } = c.var.user;
    const me: Me =
      account === "visitor" || email === null
        ? { kind: "visitor", userId, name, labId }
        : { kind: "member", userId, email, name, labId };
    return c.json(me);
  });

  return {
    guards: [bearer, csrf] as const,
    sessionRoutes,
    session: [session, requirePrincipal] as const,
    userRoutes,
  };
}
