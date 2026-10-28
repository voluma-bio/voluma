/**
 * The sign-in routes under `/api/auth`. The browser follows the redirects;
 * only `me` and `logout` return JSON, and the client parses them with these
 * schemas.
 *
 *   GET  /api/auth/login?returnTo=  → redirect to the identity provider;
 *                                     `returnTo` is a same-origin path
 *   GET  /api/auth/callback         → sets the session, redirects to `returnTo`.
 *                                     A user who belongs to no lab is refused
 *                                     with a redirect to `/?signin=not-a-member`
 *   POST /api/auth/logout           → 200 `logoutResponseSchema`; the client
 *                                     navigates to `logoutUrl`
 *   GET  /api/auth/me               → 200 `meResponseSchema`; 401 means signed out
 *
 * Every POST under `/api` must send `content-type: application/json`.
 */
import { z } from "zod";

export const meResponseSchema = z.object({
  userId: z.string(),
  email: z.string(),
  name: z.string().nullable(),
  labId: z.string(),
});
export type Me = z.infer<typeof meResponseSchema>;

export const logoutResponseSchema = z.object({ logoutUrl: z.string() });
export type LogoutResponse = z.infer<typeof logoutResponseSchema>;
