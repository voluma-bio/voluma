/**
 * What the root hands every domain: who is calling. index.ts authenticates once
 * (auth.ts) and answers 401 itself when there is no principal, so a domain reads a
 * non-null `principal` and checks only its `kind`.
 */
import type { VisitorKeys } from "@voluma/contracts/run";
import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import type { z } from "zod";

type UserBase = {
  kind: "user";
  userId: string;
  name: string | null;
  /** The user's WorkOS organization: the tenant every record is filed under. */
  labId: string;
  /**
   * Whether this account runs on Voluma's key: true for members of the pre-created organizations
   * (the ones with an entry in `Limits.voluma`, which is what the API enforces), false for a guest.
   * The browser reads it from `/me` to decide whether a run needs the user's own key.
   */
  volumaKey: boolean;
};

export type Principal =
  | (UserBase & { account: "member"; email: string })
  /** A guest the server minted: no account, no email. */
  | (UserBase & { account: "visitor" })
  | { kind: "service"; name: "runner" }
  /** `VOLUMA_DEBUG_TOKEN`: an agent debugging runs; reads runs in every lab, writes nothing. */
  | { kind: "service"; name: "debug" };

export type AppEnv = { Variables: { principal: Principal } };

export type UserPrincipal = Extract<Principal, { kind: "user" }>;

/**
 * The filter every read applies, so no handler branches on who is asking: records filed under
 * `labId` that `ownerId` created. Everyone sees only their own, plus the examples.
 */
export type Reader = { labId: string; ownerId: string };

export function readerOf(user: UserPrincipal): Reader {
  return { labId: user.labId, ownerId: user.userId };
}

/** Who starts a run or sends a message, and the own keys the request carries (a reopen of an own-key run needs them). */
export type Caller = { userId: string; keys?: VisitorKeys };

export function callerOf(user: UserPrincipal, keys?: VisitorKeys): Caller {
  return { userId: user.userId, ...(keys && { keys }) };
}

/**
 * Every lab's records: what the debug token (`VOLUMA_DEBUG_TOKEN`) reads on a run `GET`, so an
 * agent can follow and debug any run. Writes never take it; they take a `Reader`.
 */
export const EVERY_LAB = "every-lab" as const;
export type ReadScope = Reader | typeof EVERY_LAB;

/** The environment of a read handler behind `requireReader`. */
export type ReaderEnv = { Variables: { principal: Principal; reader: ReadScope } };

/** Guard a read: a user reads through `readerOf`, the debug token reads `EVERY_LAB`, anyone else is 403. */
export const requireReader = createMiddleware<ReaderEnv>(async (c, next) => {
  const principal = c.get("principal");
  switch (principal.kind) {
    case "user":
      c.set("reader", readerOf(principal));
      return next();
    case "service":
      if (principal.name !== "debug") return c.json({ error: "forbidden" }, 403);
      c.set("reader", EVERY_LAB);
      return next();
    default:
      return principal satisfies never;
  }
});

/** Guard a subtree for the runner's bearer token (run ingest). The debug token is refused. */
export const requireService = createMiddleware<AppEnv>(async (c, next) => {
  const principal = c.get("principal");
  return principal.kind === "service" && principal.name === "runner"
    ? next()
    : c.json({ error: "forbidden" }, 403);
});

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
