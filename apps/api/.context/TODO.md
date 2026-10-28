# TODO

- **Postgres migration drill.** Before the lab relies on the database: `pg_dump` from
  Railway (needs a temporary TCP proxy or `railway ssh`; remove it after), restore into a
  fresh local Postgres, run the app against the copy. Proves the "portable Postgres" rule.
- **Scheduled `pg_dump` to R2**, so backups don't depend on Railway.
- **Move the service settings into `.railway/railway.ts`** (Railway's Infrastructure as
  Code, GA; applied with `railway config plan` then `apply`, not on deploy; project tokens
  work with `RAILWAY_TOKEN`). Unblocked. Move the build, pre-deploy, start, healthcheck,
  draining, restart, sleeping and watch-path settings and the `DATABASE_URL` reference from
  [deploy.md](deploy.md)'s tables; leave secret values (`VOLUMA_API_TOKEN`) on the service.
  Then shrink those tables to a pointer. Until then they exist only on the service and drift.
