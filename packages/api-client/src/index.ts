/**
 * Typed client for apps/api over the contracts. Web features call the API only
 * through here. Requests are same-origin; a 401 on any call except `getMe`
 * emits "signed out" so the shell can show the sign-in screen.
 */
import { logoutResponseSchema, type Me, meResponseSchema } from "@voluma/contracts/auth";

const signedOutListeners = new Set<() => void>();

/** Listen for a 401 on any call but `getMe`. Returns the unsubscribe function. */
export function onSignedOut(listener: () => void): () => void {
  signedOutListeners.add(listener);
  return () => signedOutListeners.delete(listener);
}

async function request(path: string, init: { method?: "GET" | "POST" } = {}): Promise<Response> {
  const post = init.method === "POST";
  return fetch(`/api${path}`, {
    method: init.method,
    headers: post ? { "content-type": "application/json" } : undefined,
    body: post ? "{}" : undefined,
  });
}

async function json(res: Response): Promise<unknown> {
  if (res.status === 401) {
    for (const listener of signedOutListeners) listener();
  }
  if (!res.ok) throw new Error(`${res.url}: ${res.status}`);
  return res.json();
}

/** The signed-in user, or null when signed out. Being signed out on load is not an event. */
export async function getMe(): Promise<Me | null> {
  const res = await request("/auth/me");
  if (res.status === 401) return null;
  return meResponseSchema.parse(await json(res));
}

/** Ends the session, then leaves the app for the identity provider's logout page. */
export async function signOut(): Promise<void> {
  const { logoutUrl } = logoutResponseSchema.parse(
    await json(await request("/auth/logout", { method: "POST" })),
  );
  location.href = logoutUrl;
}
