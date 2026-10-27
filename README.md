# Voluma

Review UI for the mouse OA knee workflow. The current app uses an in-memory
demo service; it does not upload scans, run agents, or render medical images.

## Run locally

Use Node.js 24+ and pnpm 12.0.0. No credentials or database are required.

```sh
pnpm install --frozen-lockfile
pnpm dev
```

Open the address printed by Vite. In an Amp orb, use `amp orb services ensure`
and open its portal URL instead. `pnpm check` runs lint, typechecks, contract
tests, and the production build. `pnpm format` applies Biome formatting.

## Try the review flow

Open **Trabecular IIOC**, then **Request correction**. Preview the affected
tasks, confirm, and select R1 to inspect the earlier result. To exercise
failure and retry, choose **Demo controls → Fail next rerun** first.

**Demo limits:** reloading resets the session. Answers and revised values are
scripted. Missing numbers remain empty; CSV exports label provenance and demo
status. Evidence and file entries name expected private assets but do not link
to nonexistent downloads. Do not use these values for scientific conclusions.

The runs page is a navigation stub for the other implementation lane.
Authentication, real persistence, R2, the harness, and scientific viewers are
not implemented. Production static hosting must send `index.html` for app routes.

Architecture and integration boundaries: [`.context/CONTEXT.md`](.context/CONTEXT.md).
