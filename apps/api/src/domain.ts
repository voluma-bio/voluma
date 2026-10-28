/**
 * What the root hands every domain: who is calling. index.ts authenticates once
 * (auth.ts) and answers 401 itself when there is no principal, so a domain reads a
 * non-null `principal` and checks only its `kind`. Owned by both lanes; small PRs.
 */
import { createMiddleware } from "hono/factory";

/**
 * How much of the lab's data a user sees: `lab` is all of it; `self` only the records
 * the user created. Domains never branch on it: they pass `readerOf(user)` to their store.
 */
export type Scope = "lab" | "self";

export type Principal =
  | {
      kind: "user";
      userId: string;
      /** A `visitor` is a guest the server minted: no account, no email. */
      account: "member" | "visitor";
      email: string | null;
      name: string | null;
      /** The user's WorkOS organization: the tenant every record is filed under. */
      labId: string;
      scope: Scope;
    }
  | { kind: "service"; name: "runner" };

/** The Hono environment of a domain app: `new Hono<AppEnv>()`. */
export type AppEnv = { Variables: { principal: Principal } };

type UserPrincipal = Extract<Principal, { kind: "user" }>;

/**
 * The filter every read applies, derived from the scope so no handler branches on it:
 * records filed under `labId`, and, when `ownerId` is set, created by that user.
 */
export type Reader = { labId: string; ownerId: string | null };

export function readerOf(user: UserPrincipal): Reader {
  return { labId: user.labId, ownerId: user.scope === "self" ? user.userId : null };
}

/** Guard a subtree for the runner's bearer token (run ingest). */
export const requireService = createMiddleware<AppEnv>(async (c, next) =>
  c.get("principal").kind === "service" ? next() : c.json({ error: "forbidden" }, 403),
);

/** The environment of a subtree behind `requireUser`: `new Hono<UserEnv>().use(requireUser)`. */
export type UserEnv = { Variables: { principal: Principal; user: UserPrincipal } };

/** Guard a subtree for a signed-in member of an allowed organization, and narrow `c.var.user` to it. */
export const requireUser = createMiddleware<UserEnv>(async (c, next) => {
  const principal = c.get("principal");
  if (principal.kind !== "user") return c.json({ error: "forbidden" }, 403);
  c.set("user", principal);
  return next();
});
