# TODO

- **Postgres migration drill.** Before the lab relies on the database: `pg_dump` from
  Railway (needs a temporary TCP proxy or `railway ssh`; remove it after), restore into a
  fresh local Postgres, run the app against the copy. Proves the "portable Postgres" rule.
- **Scheduled `pg_dump` to R2**, so backups don't depend on Railway.
- **Move the service settings into `.railway/railway.ts`** (Railway's Infrastructure as
  Code; applied with the CLI's `railway config plan` and `apply`, not on deploy). Today
  they exist only on the service, recorded in [deploy.md](deploy.md).
- **Switch `@voluma/api` to the `main` branch** once the PR that adds this lands (it was
  deployed from the PR branch to verify it).
