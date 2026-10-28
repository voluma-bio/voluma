/**
 * Authentication for the whole API, at the composition root (index.ts is its only
 * caller, so there is no port). Two ways in:
 *  - `Authorization: Bearer <VOLUMA_API_TOKEN>`: the runner, principal `service`. When
 *    the header is present only the bearer counts; the cookie is never consulted.
 *  - the WorkOS AuthKit session cookie: a member of the lab, principal `user`.
 * `createAuth` returns the middleware index.ts mounts on `/api/*` (authenticate, then
 * the CSRF checks), the `/api/auth/*` routes (`signIn`, mounted before the middleware,
 * and `routes` after it), and `requirePrincipal`, the 401 for everything else. Domains see a non-null principal and check its `kind`
 * (domain.ts).
 *
 * AuthKit refreshes an expired access token inside `withAuth` and hands the new sealed
 * session back for the caller to save, so every response carries the refreshed
 * `Set-Cookie`s (each as its own header; AuthKit forbids comma-joining).
 */
import {
  CookieSessionStorage,
  configure,
  createAuthService,
  isPKCEVerifierCookieName,
  type Session,
  selectStalePKCEVerifierCookieNames,
} from "@workos/authkit-session";
import { type Context, Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { timingSafeEqual } from "hono/utils/buffer";
import type { Principal } from "./domain";

export interface AuthConfig {
  clientId: string;
  apiKey: string;
  /** Seals the session cookie; at least 32 characters. */
  cookiePassword: string;
  /** The Yao Lab organization: the only one whose members may sign in. */
  labOrganizationId: string;
  /** Where the browser reaches the app (no trailing slash). Never taken from `Host`. */
  appUrl: string;
  /** The runner's bearer token. */
  apiToken: string;
}

// The root sets these; `principal` is null until requirePrincipal has run.
type RootEnv = {
  Variables: { principal: Principal | null; sessionId: string | null; setCookies: string[] };
};

// Cookie name -> raw (still URL-encoded) value.
function parseCookies(request: Request) {
  const cookies = new Map<string, string>();
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq >= 0) cookies.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
  }
  return cookies;
}

// AuthKit's storage is abstract over the framework; ours only reads a Request's
// Cookie header and returns the Set-Cookie headers for the root to attach.
class RequestStorage extends CookieSessionStorage<Request, Response> {
  async getCookie(request: Request, name: string) {
    const raw = parseCookies(request).get(name);
    if (raw === undefined) return null;
    try {
      return decodeURIComponent(raw); // AuthKit's contract: the inverse of its encodeURIComponent
    } catch {
      return null;
    }
  }
}

// A longer returnTo grows the sealed PKCE cookie toward the 4 KB limit.
const MAX_RETURN_TO = 512;

// The session id (`sid`) of an access token. Not verified: only used to revoke, which
// WorkOS authorizes with the API key, and works on expired tokens.
function sessionIdOf(accessToken: string) {
  const payload = JSON.parse(Buffer.from(accessToken.split(".")[1] ?? "", "base64url").toString());
  return payload.sid as string;
}

// Session cookie lifetime. The refresh token, not this, bounds the session; a month
// keeps a lab member signed in across a holiday without a permanent cookie.
const COOKIE_MAX_AGE = 30 * 24 * 60 * 60;

export function createAuth(config: AuthConfig) {
  const appOrigin = new URL(config.appUrl).origin;
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
  const authkit = createAuthService<Request, Response>({
    sessionStorageFactory: (c) => new RequestStorage(c),
  });
  const asArray = (value: string | string[] | undefined) =>
    value === undefined ? [] : Array.isArray(value) ? value : [value];

  // Clears the session cookie and every pending PKCE verifier on the request, so
  // sign-out and refusals leave no AuthKit cookie behind.
  async function clearSessionCookies(request: Request) {
    const cleared = asArray((await authkit.clearSession(new Response())).headers?.["Set-Cookie"]);
    for (const cookieName of parseCookies(request).keys()) {
      if (!isPKCEVerifierCookieName(cookieName)) continue;
      const { headers } = await authkit.clearPendingVerifierByName(undefined, { cookieName });
      cleared.push(...asArray(headers?.["Set-Cookie"]));
    }
    return cleared;
  }

  // Ends the WorkOS session server-side, so a copy of the sealed cookie dies with it
  // (refresh tokens are not rotated on use). Never throws: callers clear the cookie
  // whatever happens here.
  async function revokeSession(sessionId: string) {
    try {
      await authkit.getWorkOS().userManagement.revokeSession({ sessionId });
    } catch (error) {
      const { name, status } = error as { name?: string; status?: number };
      console.error("WorkOS session revoke failed:", name, status);
    }
  }

  // A user principal from an AuthKit result, or a cleared cookie when the session's
  // organization is not the lab (the enforcement point for membership, bounded by the
  // access-token lifetime).
  async function userResult(
    request: Request,
    auth: Awaited<ReturnType<typeof authkit.withAuth>>["auth"],
    sealed: string | undefined,
  ) {
    if (!auth.user || auth.organizationId !== config.labOrganizationId) {
      return { principal: null, sessionId: null, setCookies: await clearSessionCookies(request) };
    }
    const saved = sealed
      ? (await authkit.saveSession(undefined, sealed)).headers?.["Set-Cookie"]
      : undefined;
    return {
      principal: {
        kind: "user",
        userId: auth.user.id,
        email: auth.user.email,
        name: [auth.user.firstName, auth.user.lastName].filter(Boolean).join(" ") || null,
        labId: auth.organizationId,
      } satisfies Principal,
      sessionId: auth.sessionId,
      setCookies: asArray(saved),
    };
  }

  async function authenticate(request: Request) {
    const none = { principal: null, setCookies: [] as string[], sessionId: null };
    const authorization = request.headers.get("authorization");
    if (authorization !== null) {
      const token = /^Bearer +(.+)$/i.exec(authorization)?.[1];
      const ok = token !== undefined && (await timingSafeEqual(token, config.apiToken));
      return ok ? { ...none, principal: { kind: "service", name: "runner" } as const } : none;
    }

    const { auth, refreshedSessionData } = await authkit.withAuth(request);
    if (auth.user) return userResult(request, auth, refreshedSessionData);

    // withAuth swallows every error. A request that carried a session cookie and got
    // no user is a dead cookie or a transient failure; tell them apart by refreshing
    // once more. Clear the cookie only for an unreadable cookie or a refresh token
    // WorkOS refuses (`invalid_grant`: revoked, expired). Otherwise leave it, so a
    // WorkOS outage does not sign people out. Once cleared, the dead cookie costs no
    // further WorkOS calls.
    let session: Session | null;
    try {
      session = await authkit.getSession(request);
    } catch {
      return { ...none, setCookies: await clearSessionCookies(request) };
    }
    if (session === null) return none;
    try {
      const refreshed = await authkit.refreshSession(session);
      return userResult(request, refreshed.auth, refreshed.encryptedSession);
    } catch (error) {
      const cause = (error as { cause?: { error?: string } }).cause;
      return cause?.error === "invalid_grant"
        ? { ...none, setCookies: await clearSessionCookies(request) }
        : none;
    }
  }

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

  const authenticateRequest = createMiddleware<RootEnv>(async (c, next) => {
    const result = await authenticate(c.req.raw);
    c.set("principal", result.principal);
    c.set("sessionId", result.sessionId);
    c.set("setCookies", result.setCookies);
    await next();
    // One writer for the session cookie: a response that sets it itself (logout)
    // wins over the refresh or clear the middleware queued.
    const own = c.res.headers.getSetCookie().some((cookie) => cookie.startsWith(`${cookieName}=`));
    if (own) return;
    for (const cookie of c.get("setCookies")) c.res.headers.append("Set-Cookie", cookie);
  });

  const redirectWithCookies = (url: string, cookies: string[]) => {
    const headers = new Headers({ Location: url });
    for (const cookie of cookies) headers.append("Set-Cookie", cookie);
    return new Response(null, { status: 302, headers });
  };

  // Sign-in routes authenticate through PKCE and state, not the session, so they are
  // mounted before the middleware: no refresh round trip, and no queued session cookie
  // that could overwrite the one the callback issues.
  const signIn = new Hono<RootEnv>();

  signIn.get("/login", async (c) => {
    const returnTo = c.req.query("returnTo");
    const { url, headers } = await authkit.createSignIn(undefined, {
      returnPathname:
        returnTo !== undefined && returnTo.length <= MAX_RETURN_TO ? returnTo : undefined,
      organizationId: config.labOrganizationId,
    });
    const cookies = asArray(headers?.["Set-Cookie"]);
    // Verifier cookies are per flow and accumulate; evict the stale ones before the
    // Cookie header outgrows the server's limit.
    const keep = cookies[0]?.split("=")[0] ?? "";
    for (const cookieName of selectStalePKCEVerifierCookieNames(parseCookies(c.req.raw).keys(), {
      keep,
    })) {
      const evicted = await authkit.clearPendingVerifierByName(undefined, { cookieName });
      cookies.push(...asArray(evicted.headers?.["Set-Cookie"]));
    }
    return redirectWithCookies(url, cookies);
  });

  signIn.get("/callback", async (c) => {
    const code = c.req.query("code");
    const state = c.req.query("state");
    if (!code) return c.redirect("/?signin=failed");
    let result: Awaited<ReturnType<typeof authkit.handleCallback>>;
    try {
      result = await authkit.handleCallback(c.req.raw, new Response(), { code, state });
    } catch (error) {
      // A reused or expired callback link (bad state, spent code) lands here.
      console.error("sign-in callback failed:", error);
      return c.redirect("/?signin=failed");
    }
    const cookies = asArray(result.headers?.["Set-Cookie"]);
    if (result.authResponse.organizationId === config.labOrganizationId) {
      return redirectWithCookies(`${config.appUrl}${result.returnPathname}`, cookies);
    }
    // Not a member: handleCallback has already sealed a session. Keep none of it,
    // and end it at WorkOS so no usable session survives.
    await revokeSession(sessionIdOf(result.authResponse.accessToken));
    const kept = cookies.filter((cookie) => !cookie.startsWith(`${cookieName}=`));
    return redirectWithCookies(`${config.appUrl}/?signin=not-a-member`, [
      ...kept,
      ...(await clearSessionCookies(c.req.raw)),
    ]);
  });

  const routes = new Hono<RootEnv>();

  routes.post("/logout", async (c) => {
    // End the WorkOS session here, not only in the browser: a copy of the sealed
    // cookie must stop working. The unseal needs no refresh, so it works while
    // WorkOS is unreachable.
    let logoutUrl = "/";
    try {
      const session = await authkit.getSession(c.req.raw);
      if (session) {
        const sessionId = sessionIdOf(session.accessToken);
        await revokeSession(sessionId);
        // The browser still visits logoutUrl, which ends WorkOS's own AuthKit session.
        ({ logoutUrl } = await authkit.signOut(sessionId, { returnTo: `${config.appUrl}/` }));
      }
    } catch {
      // An unreadable cookie has no session to revoke; it is cleared below.
    }
    return jsonWithCookies(c, { logoutUrl }, await clearSessionCookies(c.req.raw));
  });

  routes.get("/me", (c) => {
    const principal = c.get("principal");
    if (principal === null) return c.json({ error: "unauthorized" }, 401);
    if (principal.kind !== "user") return c.json({ error: "forbidden" }, 403);
    // TODO(contract): satisfies MeResponse
    return c.json({
      userId: principal.userId,
      email: principal.email,
      name: principal.name,
      labId: principal.labId,
    });
  });

  // 401 for every /api path past the auth routes that has no principal.
  const requirePrincipal = createMiddleware<RootEnv>(async (c, next) =>
    c.get("principal") === null ? c.json({ error: "unauthorized" }, 401) : next(),
  );

  return { signIn, middleware: [authenticateRequest, csrf] as const, routes, requirePrincipal };
}

function jsonWithCookies(c: Context<RootEnv>, body: object, cookies: string[]) {
  for (const cookie of cookies) c.header("Set-Cookie", cookie, { append: true });
  return c.json(body);
}
