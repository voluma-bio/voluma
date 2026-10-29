/**
 * What the root hands every domain: who is calling. index.ts authenticates once
 * (auth.ts) and answers 401 itself when there is no principal, so a domain reads a
 * non-null `principal` and checks only its `kind`. Owned by both lanes; small PRs.
 */
import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import type { z } from "zod";

/**
 * How much of the lab's data a user sees: `lab` is all of it; `self` only the records
 * the user created. Domains never branch on it: they pass `readerOf(user)` to their store.
 */
export type Scope = "lab" | "self";

type UserBase = {
  kind: "user";
  userId: string;
  name: string | null;
  /** The user's WorkOS organization: the tenant every record is filed under. */
  labId: string;
  scope: Scope;
};

export type Principal =
  | (UserBase & { account: "member"; email: string })
  /** A guest the server minted: no account, no email. */
  | (UserBase & { account: "visitor" })
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

/**
 * Every lab's records: what the runner's bearer token reads on a run `GET`, so an agent can
 * debug a run with the token. Writes never take it; they take a `Reader`.
 */
export const EVERY_LAB = "every-lab" as const;
export type ReadScope = Reader | typeof EVERY_LAB;

/** The environment of a read subtree behind `requireReader`. */
export type ReaderEnv = { Variables: { principal: Principal; reader: ReadScope } };

/** Guard a read for a user (their `readerOf`) or the runner's bearer token (`EVERY_LAB`). */
export const requireReader = createMiddleware<ReaderEnv>(async (c, next) => {
  const principal = c.get("principal");
  c.set("reader", principal.kind === "user" ? readerOf(principal) : EVERY_LAB);
  return next();
});

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

/** A request's JSON body as `schema` parses it; anything else is a 400 carrying the parse message. */
export async function parseJson<T extends z.ZodType>(c: Context, schema: T): Promise<z.output<T>> {
  const parsed = schema.safeParse(await c.req.json().catch(() => undefined));
  if (!parsed.success) throw new HTTPException(400, { message: parsed.error.message });
  return parsed.data;
}
