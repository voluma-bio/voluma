/**
 * Asks the server for a guest identity when nobody is signed in. Lives here, not in
 * `@voluma/api-client`, until a contract PR adds `startGuest()` there.
 */
import { type Me, meResponseSchema } from "@voluma/contracts/auth";

/** The guest `Me`, or null when the server has guests off (404). */
export async function startGuest(): Promise<Me | null> {
  const res = await fetch("/api/auth/guest", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`/api/auth/guest: ${res.status}`);
  return meResponseSchema.parse(await res.json());
}
