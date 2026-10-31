/**
 * The sign-in routes under `/api/auth`. The browser follows the redirects;
 * `me`, `guest` and `logout` return JSON, and the client parses them with
 * these schemas.
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
 *   POST /api/auth/guest            → 200 `meResponseSchema` (`kind: "visitor"`):
 *                                     the caller's guest identity, made on first
 *                                     call and kept in a cookie; 404 when the
 *                                     server lets no guests in
 *   POST /api/auth/password         body `passwordSignInRequestSchema` → 200
 *                                     `meResponseSchema` and the session cookie,
 *                                     for scripts (the scan upload CLI); a browser
 *                                     signs in through `login`. 401 when the
 *                                     identity provider refuses the sign-in (a wrong
 *                                     email or password, or an account that must
 *                                     sign in another way: SSO, MFA), 403 for a user
 *                                     who belongs to no allowed organization, 429
 *                                     after too many failed attempts for the email
 *                                     (the server counts them, and passes the
 *                                     caller's address and user agent to the
 *                                     provider, which limits too); the server
 *                                     never logs the request body. A
 *                                     script, which sends no `Origin` by itself,
 *                                     must send the rules below on this and every
 *                                     later call: `Origin: <app URL>` and
 *                                     `content-type: application/json`
 *
 * Rules for every request under `/api` that doesn't carry the runner's bearer token:
 *   - A non-GET/HEAD request must send `content-type: application/json`, or
 *     the server answers 415.
 *   - `Origin` must equal the app's origin, or the server answers 403 (its
 *     message tells a person to reload). Browsers send it on same-origin fetches.
 * `me` also answers 403 to a bearer (non-cookie) principal.
 */
import { z } from "zod";

/** The `?signin=` value on the redirect after a refused sign-in. Parse it with `safeParse`; an unknown value means the plain sign-in screen. */
export const signinOutcomeSchema = z.enum(["not-a-member", "failed"]);
export type SigninOutcome = z.infer<typeof signinOutcomeSchema>;

/** A WorkOS user id, or a server-minted id for a guest (an anonymous visitor). */
export const userIdSchema = z.string();

const meFields = {
  userId: userIdSchema,
  name: z.string().nullable(),
  labId: z.string(),
};

/**
 * Who is signed in. `member` is a WorkOS account (a lab member or a judge);
 * `visitor` is a guest: anyone without an account, given a server-minted id
 * by `POST /api/auth/guest`, with no email. A guest has no sign-out; signing
 * in as a member replaces it, and signing out returns to being a guest (the
 * browser's earlier guest, or a new one if it had none).
 */
export const meResponseSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("member"), email: z.string(), ...meFields }),
  z.object({ kind: z.literal("visitor"), ...meFields }),
]);
export type Me = z.infer<typeof meResponseSchema>;

export const logoutResponseSchema = z.object({ logoutUrl: z.string() });
export type LogoutResponse = z.infer<typeof logoutResponseSchema>;

/** A member's own email and password, for a script that signs in without a browser. */
export const passwordSignInRequestSchema = z.object({
  email: z.string().min(1).max(320),
  password: z.string().min(1).max(1024),
});
export type PasswordSignInRequest = z.infer<typeof passwordSignInRequestSchema>;
