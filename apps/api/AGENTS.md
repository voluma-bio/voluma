# apps/api

Node server on Postgres. Architecture and the `seq` allocator: [.context/CONTEXT.md](../../.context/CONTEXT.md).

- Tables are Drizzle schemas, one file per domain (`src/domains/<domain>/schema.ts`).
  Change the schema, then `pnpm --filter @voluma/api db:generate` writes a `.sql`
  migration to `drizzle/`. Commit it. Never run `drizzle-kit push`.
- **After merging `origin/main`, delete your branch's unmerged generated migration
  (its `drizzle/*.sql` and the matching entry and snapshot in `drizzle/meta/`) and
  regenerate it, then `pnpm db:reset`.** The worktree's database still holds the old
  migration and cannot apply the new one; `db:reset` drops it and `pnpm dev` rebuilds it. Two branches that generate from the same base collide on the
  migration number, the journal and the snapshots.
- Migrations run from one place, `src/migrate.ts` (`pnpm db:migrate`): `pnpm dev` runs it
  locally, Railway's pre-deploy step in production. Never at server start: `migrate()`
  takes no lock. It is not drizzle-kit, a devDependency that Railway prunes.
- **A migration must work with the code that is deployed now.** Railway migrates, then
  starts the new deployment beside the old one, which keeps serving until `/health`
  passes, and the migration stays applied if that deploy fails. So expand first (add
  nullable columns or tables, columns with defaults), and contract (drop, rename, add
  `NOT NULL`) in a later PR, after the code that stopped using the old shape is deployed.
  See [.context/deploy.md](.context/deploy.md).
- Anything the server or `migrate.ts` runs in production belongs in `dependencies`
  (Railway prunes dev dependencies after the build).
- When `apps/web/dist` exists, `index.ts` also serves it (hashed `assets/` immutable,
  everything else `no-cache`, the app shell for extensionless non-`/api` GETs). Deploying to staging:
  [.context/deploy.md](.context/deploy.md).
- `pi_messages.message` stays `text`; `jsonb` would reorder keys and break the
  byte-for-byte history.
- Only `src/index.ts` reads env. It hands `createAuth` (`src/auth.ts`) the WorkOS values;
  AuthKit would otherwise read `WORKOS_*` from `process.env` itself.
- **Guests are principals too.** `GUEST_ORGANIZATION_ID`/`GUEST_SCOPE` (read in `index.ts`)
  make a request with no credential a `user` with `account: "visitor"` and `email: null`
  (`auth.ts`); `readerOf` is still the only place scope becomes a filter. Unset: 401.
- **Domains read the caller from the context, not the request.** The root authenticates
  once (`src/auth.ts`) and answers 401 when there is no principal. A domain app is
  `new Hono<AppEnv>()` (`src/domain.ts`) and reads `c.get("principal")`; the runner's
  ingest subtree is behind `requireService`. A subtree for signed-in members is
  `new Hono<UserEnv>().use(requireUser)`, whose handlers read the narrowed
  `c.var.user` (`userId`, `email`, `name`, `labId`, `scope`) and never check `kind`. Any
  other kind gets 403. **Reads go through the reader:** a domain passes `readerOf(c.var.user)`
  (`src/domain.ts`: `{ labId, ownerId }`, `ownerId` null for a lab member and the user's id for
  a `self` user) into its store port's read methods, and the adapter applies it once
  (`labId = ? AND (ownerId IS NULL OR created_by = ownerId)`). Handlers never branch on
  `scope`, which is server-internal; no domain reads an organization id. A domain never reads cookies, tokens or `Origin`; the CSRF and Origin checks
  are the root's.
- Each domain's factory returns a Hono app, mounted by `index.ts` with `app.route`. Use
  Hono's routing and params; the root's JSON 404 and `onError` cover the domains.
- A domain's tables and their Postgres adapters live in the domain
  (`src/domains/<domain>/pg-*.ts`), constructed only by `index.ts`. `src/adapters/` is for
  adapters of the shared `src/ports/`.
- `pnpm dev` is the only launcher, and it starts the API with the repo `.env`.
