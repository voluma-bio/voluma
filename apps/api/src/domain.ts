/**
 * What the root hands every domain: who is calling. index.ts authenticates once
 * (auth.ts) and answers 401 itself when there is no principal, so a domain reads a
 * non-null `principal` and checks only its `kind`. Owned by both lanes; small PRs.
 */
import { createMiddleware } from "hono/factory";

export type Principal =
  | { kind: "user"; userId: string; email: string; name: string | null; labId: string }
  | { kind: "service"; name: "runner" };

/** The Hono environment of a domain app: `new Hono<AppEnv>()`. */
export type AppEnv = { Variables: { principal: Principal } };

const only = (kind: Principal["kind"]) =>
  createMiddleware<AppEnv>(async (c, next) =>
    c.get("principal").kind === kind ? next() : c.json({ error: "forbidden" }, 403),
  );

/** Guard a subtree for the runner's bearer token (run ingest). */
export const requireService = only("service");
/** Guard a subtree for a signed-in lab member. */
export const requireUser = only("user");
