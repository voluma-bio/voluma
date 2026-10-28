/**
 * Authentication for the whole API, at the composition root (index.ts is its only
 * caller, so there is no port). Two ways in:
 *  - `Authorization: Bearer <VOLUMA_API_TOKEN>`: the runner, principal `service`. When
 *    the header is present only the bearer counts; the cookie is never consulted.
 *  - the WorkOS AuthKit session cookie: a member of an allowed organization, principal
 *    `user` (its `labId` is that organization, its `scope` the organization's entry).
 * `createAuth` returns the pieces index.ts mounts on `/api/*`, in this order:
 *  1. `guards`: the bearer check and the CSRF rules. No I/O, so a forged request makes no
 *     WorkOS call.
 *  2. `sessionRoutes`: login, callback and logout, the only writers of the session cookie.
 *  3. `session`, then `requirePrincipal`: the cookie becomes a user principal, and
 *     everything else without a principal is a 401. This is the only place that
 *     validates the cookie and refreshes an expired access token with WorkOS; the
 *     refreshed `Set-Cookie`s ride on the response (each its own header: AuthKit forbids
 *     comma-joining).
 *  4. `userRoutes` and the domains, which see a non-null principal (domain.ts).
 */
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
import { GenericServerException, OauthException, WorkOS } from "@workos-inc/node";
import { type Context, Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { timingSafeEqual } from "hono/utils/buffer";
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

// Every WorkOS call is on a request path (refresh, revoke, code exchange), so it is
// bounded: one attempt, 3 s. The SDK's default is 4 attempts and 60 s each.
const WORKOS_TIMEOUT_MS = 3000;

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

// What @workos-inc/node's classifyRetryableRefreshError (not exported) treats as
// transient: 408, 429, 5xx and network errors. A request that fails this way keeps its
// cookie; any other refresh failure (a revoked or expired session, `sso_required`, ...)
// means the cookie is dead.
function isTransientRefreshError(error: unknown) {
  if (!(error instanceof TokenRefreshError)) return false;
  const cause = error.cause;
  const status =
    cause instanceof OauthException || cause instanceof GenericServerException
      ? cause.status
      : undefined;
  return (
    status === 408 ||
    status === 429 ||
    (status !== undefined && status >= 500) ||
    cause instanceof TypeError ||
    (cause instanceof Error && cause.cause instanceof TypeError)
  );
}

function userPrincipal(user: User, labId: string, scope: Scope): Principal {
  return {
    kind: "user",
    userId: user.id,
    email: user.email,
    name: [user.firstName, user.lastName].filter(Boolean).join(" ") || null,
    labId,
    scope,
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

  // Ends WorkOS sessions server-side, so a copy of a sealed cookie dies with them
  // (refresh tokens are not rotated on use). Never throws: callers clear the cookie
  // whatever happens here.
  async function revokeSessions(sessionIds: (string | null)[]) {
    await Promise.all(
      sessionIds.map(async (sessionId) => {
        if (sessionId === null) return;
        try {
          await workos.userManagement.revokeSession({ sessionId });
        } catch (error) {
          const { name, status } = error as { name?: string; status?: number };
          console.error("WorkOS session revoke failed:", name, status);
        }
      }),
    );
  }

  // The session id (`sid`) of the request's cookie, read without refreshing (it works on
  // an expired token, and while WorkOS is unreachable), or null for no readable cookie.
  async function requestSessionId(request: Request) {
    try {
      const session = await authkit.getSession(request);
      return session ? (core.parseTokenClaims(session.accessToken).sid ?? null) : null;
    } catch {
      return null;
    }
  }

  // The principal for a request's session cookie, or null; cookies to set go to `sink`.
  // A dead cookie is cleared (once cleared it costs no further WorkOS calls), a
  // transient WorkOS failure keeps it, so an outage does not sign people out.
  async function userFromCookie(request: Request, sink: string[]) {
    let session: Awaited<ReturnType<typeof authkit.getSession>>;
    try {
      session = await authkit.getSession(request);
    } catch {
      await clearSessionCookies(request, sink);
      return null;
    }
    if (session === null) return null;
    let result: Awaited<ReturnType<typeof core.validateAndRefresh>>;
    try {
      result = await core.validateAndRefresh(session);
    } catch (error) {
      if (!isTransientRefreshError(error)) await clearSessionCookies(request, sink);
      return null;
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
    c.set("principal", await userFromCookie(c.req.raw, cookies));
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
    const newId = core.parseTokenClaims(result.authResponse.accessToken).sid ?? null;
    const oldId = await requestSessionId(c.req.raw);
    const stale = oldId === newId ? null : oldId;
    if (scopes.has(result.authResponse.organizationId ?? "")) {
      await revokeSessions([stale]);
      setCookies(c, cookies);
      return c.redirect(`${config.appUrl}${result.returnPathname}`);
    }
    // Not in an allowed organization: handleCallback has already sealed a session. Keep none of it,
    // and end it at WorkOS so no usable session survives.
    await revokeSessions([newId, stale]);
    cookies.length = 0;
    await clearSessionCookies(c.req.raw, cookies);
    setCookies(c, cookies);
    return c.redirect(`${config.appUrl}/?signin=not-a-member`);
  });

  sessionRoutes.post("/logout", async (c) => {
    // End the WorkOS session here, not only in the browser: a copy of the sealed
    // cookie must stop working.
    const sessionId = await requestSessionId(c.req.raw);
    await revokeSessions([sessionId]);
    // The browser still visits logoutUrl, which ends WorkOS's own AuthKit session.
    const logoutUrl = sessionId
      ? workos.userManagement.getLogoutUrl({ sessionId, returnTo: `${config.appUrl}/` })
      : "/";
    const cookies: string[] = [];
    await clearSessionCookies(c.req.raw, cookies);
    setCookies(c, cookies);
    return c.json({ logoutUrl });
  });

  const userRoutes = new Hono<UserEnv>().use(requireUser);

  userRoutes.get("/me", (c) => {
    const { userId, email, name, labId } = c.var.user;
    // TODO(contract): satisfies MeResponse
    return c.json({ userId, email, name, labId });
  });

  return {
    guards: [bearer, csrf] as const,
    sessionRoutes,
    session: [session, requirePrincipal] as const,
    userRoutes,
  };
}
