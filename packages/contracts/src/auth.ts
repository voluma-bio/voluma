/**
 * The sign-in routes under `/api/auth`. The browser follows the redirects;
 * only `me` and `logout` return JSON, and the client parses them with these
 * schemas.
 *
 *   GET  /api/auth/login?returnTo=  → redirect to the identity provider;
 *                                     `returnTo` is a same-origin path
 *   GET  /api/auth/callback         → sets the session, redirects to `returnTo`.
 *                                     Failures redirect to `/?signin=<outcome>`
 *                                     (`signinOutcomeSchema`): `not-a-member` for
 *                                     a user who belongs to no lab, `failed` for a
 *                                     missing `code` or a reused or expired link
 *   POST /api/auth/logout           → 200 `logoutResponseSchema`; the client
 *                                     navigates to `logoutUrl`
 *   GET  /api/auth/me               → 200 `meResponseSchema`; 401 means signed out
 *
 * Rules for every cookie-authenticated request under `/api`:
 *   - A non-GET/HEAD request must send `content-type: application/json`, or
 *     the server answers 415.
 *   - `Origin` must equal the app's origin, or the server answers 403
 *     `forbidden origin`. Browsers send it on same-origin fetches.
 * `me` also answers 403 to a bearer (non-cookie) principal.
 */
import { z } from "zod";

/** The `?signin=` value on the redirect after a refused sign-in. Parse it with `safeParse`; an unknown value means the plain sign-in screen. */
export const signinOutcomeSchema = z.enum(["not-a-member", "failed"]);
export type SigninOutcome = z.infer<typeof signinOutcomeSchema>;

/** A WorkOS user id. */
export const userIdSchema = z.string();

export const meResponseSchema = z.object({
  userId: userIdSchema,
  email: z.string(),
  name: z.string().nullable(),
  labId: z.string(),
});
export type Me = z.infer<typeof meResponseSchema>;

export const logoutResponseSchema = z.object({ logoutUrl: z.string() });
export type LogoutResponse = z.infer<typeof logoutResponseSchema>;
