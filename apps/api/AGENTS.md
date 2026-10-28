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
- Migrations run from one place: `pnpm db:migrate` locally (`pnpm dev` does it), the
  deploy's pre-deploy step later. Never at server start: `migrate()` takes no lock.
- `pi_messages.message` stays `text`; `jsonb` would reorder keys and break the
  byte-for-byte history.
- Only `src/index.ts` reads env.
