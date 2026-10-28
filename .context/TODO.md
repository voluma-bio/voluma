# TODO

Deferred repo-wide work. Lane-specific items go in that directory's
`.context/TODO.md`; cross-lane items go in GitHub issues.

Contracts, written when something produces or consumes them (the first contracts PR covers the R2 key layout, the v0 event kinds and the review data):
- A command map (name → zod input and output), including the review corrections (a request, and a proposal of what it would redo); `api-client` becomes one generic typed `call(name, input)` and `subscribe(runId)` over HTTP, so a new command needs no `api-client` edit.
- The `task`, `value` and `compaction` event kinds, with the checklist, `report_value` and compaction.
- An importer that turns the real OA6-1RK reference run into the review-data format, so the Review lane works on real data from day one. No hand-made fixtures.

Later:
- Local dev can't connect web to API yet: run the Worker inside Vite with `@cloudflare/vite-plugin` (one port, one origin) and make `pnpm dev` start both, instead of hard-coding a Wrangler port.
- `/dev/ui` repeats the token list from `tokens.css` (`THEME_TOKENS`, `VIEWER_TOKENS`); read the custom properties at runtime instead.
- `pnpm data:pull`: fetch the OA6-1RK scan and reference run from R2 into `.data/`. Both lanes need it from day one; blocked on the bucket existing.
- Nx 24 and TypeScript 7 are released; the workspace is on Nx 23 and TypeScript 6. Upgrade in their own PR and check `pnpm check` timings.
- Pin the sandbox image's base (`python:3.12-slim` in `apps/runner/src/publish-image.ts`) by digest so two builds match.
- Harness: `tool.output` flushes only when the next chunk arrives, so a command that prints once and then goes quiet shows nothing live until it ends. Add a timer flush when the live stream (PR F) needs it.
- Harness: a `bash` result keeps and stores at most 4 MB of output (`KEEP_CHARS` in `tools/bash.ts`); the model is told when output was dropped. Storing it takes one sandbox command per 48 KB. A tool that returns large files should write them to `/outputs` instead; revisit if a real task needs more.
- Harness: first real-model run (OpenAI and Claude) on the OA6-1RK task: see the PR for what has and hasn't been run.
