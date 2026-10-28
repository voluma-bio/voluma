/**
 * Authentication for the whole API, at the composition root (index.ts is its only
 * caller, so there is no port). Two ways in:
 *  - `Authorization: Bearer <VOLUMA_API_TOKEN>`: the runner, principal `service`. When
 *    the header is present only the bearer counts; the cookie is never consulted.
 *  - the WorkOS AuthKit session cookie: a member of the lab, principal `user`.
 * `createAuth` returns the middleware index.ts mounts on `/api/*` (authenticate, then
 * the CSRF checks), the `/api/auth/*` routes, and `requirePrincipal`, the 401 for
 * everything else. Domains see a non-null principal and check its `kind`
 * (domain.ts).
 *
 * AuthKit refreshes an expired access token inside `withAuth` and hands the new sealed
 * session back for the caller to save, so every response carries the refreshed
 * `Set-Cookie`s (each as its own header; AuthKit forbids comma-joining).
 */
import { CookieSessionStorage, configure, createAuthService } from "@workos/authkit-session";
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

// AuthKit's storage is abstract over the framework; ours only reads a Request's
// Cookie header and returns the Set-Cookie headers for the root to attach.
class RequestStorage extends CookieSessionStorage<Request, Response> {
  async getCookie(request: Request, name: string) {
    for (const part of (request.headers.get("cookie") ?? "").split(";")) {
      const eq = part.indexOf("=");
      if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
    }
    return null;
  }
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

  async function clearSessionCookies() {
    return asArray((await authkit.clearSession(new Response())).headers?.["Set-Cookie"]);
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
    if (!auth.user) return none;
    // The enforcement point for membership, bounded by the access-token lifetime.
    if (auth.organizationId !== config.labOrganizationId) {
      return { ...none, setCookies: await clearSessionCookies() };
    }
    const saved = refreshedSessionData
      ? (await authkit.saveSession(undefined, refreshedSessionData)).headers?.["Set-Cookie"]
      : undefined;
    return {
      principal: {
        kind: "user",
        userId: auth.user.id,
        email: auth.user.email,
        name: [auth.user.firstName, auth.user.lastName].filter(Boolean).join(" ") || null,
        labId: auth.organizationId,
      } satisfies Principal,
      setCookies: asArray(saved),
      sessionId: auth.sessionId,
    };
  }

  // The origin and content-type rules for requests that authenticate by cookie.
  // SameSite=Lax is same-site, not same-origin (every *.voluma.bio host is same-site),
  // so state-changing requests and WebSocket upgrades must come from the app's origin.
  // Bearer requests carry no ambient credential and are exempt.
  const csrf = createMiddleware<RootEnv>(async (c, next) => {
    const { method, headers } = c.req.raw;
    const mutates = method !== "GET" && method !== "HEAD";
    const upgrade = headers.get("upgrade")?.toLowerCase() === "websocket";
    if (headers.has("authorization") || !(mutates || upgrade)) return next();
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
    for (const cookie of c.get("setCookies")) c.res.headers.append("Set-Cookie", cookie);
  });

  const redirectWithCookies = (url: string, cookies: string[]) => {
    const headers = new Headers({ Location: url });
    for (const cookie of cookies) headers.append("Set-Cookie", cookie);
    return new Response(null, { status: 302, headers });
  };

  // Ends the WorkOS session server-side (the SDK has no call for it).
  async function revokeSession(accessToken: string) {
    const { sid } = JSON.parse(
      Buffer.from(accessToken.split(".")[1] ?? "", "base64url").toString(),
    );
    const res = await fetch("https://api.workos.com/user_management/sessions/revoke", {
      method: "POST",
      headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: sid }),
    });
    if (!res.ok) console.error(`WorkOS session revoke failed: ${res.status}`);
  }

  const routes = new Hono<RootEnv>();

  routes.get("/login", async (c) => {
    const { url, headers } = await authkit.createSignIn(undefined, {
      returnPathname: c.req.query("returnTo"),
      organizationId: config.labOrganizationId,
    });
    return redirectWithCookies(url, asArray(headers?.["Set-Cookie"]));
  });

  routes.get("/callback", async (c) => {
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
    await revokeSession(result.authResponse.accessToken);
    const kept = cookies.filter((cookie) => !cookie.startsWith(`${cookieName}=`));
    return redirectWithCookies(`${config.appUrl}/?signin=not-a-member`, [
      ...kept,
      ...(await clearSessionCookies()),
    ]);
  });

  routes.post("/logout", async (c) => {
    // This response replaces any refreshed cookie the middleware queued.
    c.set("setCookies", []);
    const sessionId = c.get("sessionId");
    if (sessionId === null) {
      return jsonWithCookies(c, { logoutUrl: "/" }, await clearSessionCookies());
    }
    const { logoutUrl, headers } = await authkit.signOut(sessionId, {
      returnTo: `${config.appUrl}/`,
    });
    return jsonWithCookies(c, { logoutUrl }, asArray(headers?.["Set-Cookie"]));
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

  return { middleware: [authenticateRequest, csrf] as const, routes, requirePrincipal };
}

function jsonWithCookies(c: Context<RootEnv>, body: object, cookies: string[]) {
  for (const cookie of cookies) c.header("Set-Cookie", cookie, { append: true });
  return c.json(body);
}
