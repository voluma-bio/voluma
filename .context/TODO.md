# TODO

Deferred repo-wide work. Lane-specific items go in that directory's
`.context/TODO.md`; cross-lane items go in GitHub issues.

For the contracts PR (from the structure review of the scaffold):
- Contracts declare a command map and an event map (name → zod input and output); `api-client` becomes one generic typed `call(name, input)` and `subscribe(threadId)` with an HTTP transport and a fixtures transport, so a new command needs no `api-client` edit and each lane runs against fixtures alone.
- One file per contract (workflow, events, run record, commands) with subpath exports, plus `./fixtures/*`; include `fixtures/` in the tsconfig, and add one vitest test that parses every fixture with its schema.
- Two more cross-lane formats belong in contracts: the R2 key layout (`runs/<runId>/outputs/<task>/…`, as path builders) and the format of each task's output files (values, evidence manifest).
- Python consumers (`voluma-bio/microct-analysis`): write JSON Schema from the zod schemas into committed `packages/contracts/schema/*.json`, checked in CI, or drop the claim that Python types are generated (`packages/contracts/src/index.ts`).

Later:
- Local dev can't connect web to API yet: run the Worker inside Vite with `@cloudflare/vite-plugin` (one port, one origin) and make `pnpm dev` start both, instead of hard-coding a Wrangler port.
- The local compute adapter: `apps/api` is a Worker and can't spawn processes, so either use the Cloudflare Sandbox under `wrangler dev`, or add a small Node dev host.
- `/dev/ui` repeats the token list from `tokens.css` (`THEME_TOKENS`, `VIEWER_TOKENS`); read the custom properties at runtime instead.
- `pnpm data:pull`: fetch the OA6-1RK assets from R2 into `.data/` once the bucket exists.
- Nx 24 and TypeScript 7 are released; the workspace is on Nx 23 and TypeScript 6. Upgrade in their own PR and check `pnpm check` timings.
