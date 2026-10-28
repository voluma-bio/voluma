# Repo architecture

How the workspace fits together and why it is set up this way. Rules and
commands are in [AGENTS.md](../AGENTS.md).

## Shape

```
apps/web        React + Vite. shell/ mounts routes; features/run and features/review own screens
apps/api        Node server on Postgres (Drizzle), each domain a Hono app. src/index.ts is the
                composition root: the only code that reads env; it builds the adapters and
                mounts domains/run at /api/run/ (runs, the event log) and domains/review at
                /api/review/ (review data, chat threads, corrections) with app.route. A
                domain's tables and Postgres adapters live in the domain; adapters/ is for
                shared ports
                Sign-in: see Authentication
apps/runner     Node entry point that runs the agent harness against the API (Run lane)
packages/
  contracts     zod schemas for the four contracts and the shared formats
  harness       the agent harness: our tools, the Sandbox and EventLog ports, the Pi
                adapter; runtime-neutral (no Node types)
  workflow      pure functions over a workflow package: read and validate it, task graph, stale tasks
  api-client    typed commands and event stream; the only way web features reach the API
  viewer        local DICOM ZIP intake, Cornerstone acquired slices, persistent imaging slots
  ui            shared React components, styled from tokens
  design-tokens tokens.css (raw values, two themes) and theme.css (Tailwind mapping)
tools/ci        PR-body check
tools/dev.mjs   the `pnpm dev` launcher (below)
```

Dependencies point down: apps → feature code → packages. `contracts` and
`design-tokens` depend on nothing.

## The agent runtime

The agent loop is Pi's (`@earendil-works/pi-agent-core`), used as it comes;
we add our own pieces only when a real run needs them. The agent runs
outside the sandbox, so credentials never enter it. A run is a tree of
threads: a supervisor (the root), a worker that goes through the task
checklist, check threads, and review chat threads.
- **Event log.** Ours, kept separately from Pi's history: the `threads` and
  `events` tables in Postgres, behind the run domain's API. Each event is saved
  before it is published, and `seq` (per run) is the stream cursor. Both the
  UI and the review read this log. Pi's own messages go in `pi_messages`,
  one row per message, so a thread can resume.
- **Sandboxes.** One Modal sandbox per sandbox, CPU or GPU, created by the Node
  runner through the `Sandbox` port (`packages/harness/src/ports/sandbox.ts`); the
  adapter is `apps/runner/src/modal-sandbox.ts`, the only file that imports `modal`
  (pinned: the JS SDK is pre-1.0). It mounts R2 prefixes that don't overlap: the
  workflow and the inputs read-only, the run's scratch and outputs read-write. Each
  mount gets its own temporary R2 credential, limited to its prefix and the sandbox's
  lifetime, minted from `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_BUCKET` and `CLOUDFLARE_API_TOKEN`; the credentials never enter
  the sandbox. Inputs flagged `stage` are copied to local disk at their mount path at create (a cold
  mounted read of the scan is slow; see the POC in the docs repo, `research/modal-poc.md`);
  the bucket is mounted privately for the copy. Each sandbox gets a fresh name (Modal
  names are unique among running sandboxes, so a sandbox a dead runner left behind
  would block a resume). `packages/harness/src/layout.ts` owns which prefix is mounted
  where; prompts and tools take paths from it.
  There is no internet. The image is prebuilt and named
  (`pnpm --filter @voluma/runner publish-image <name>`). Every command runs
  under `timeout -k`, which leads its own process group,; a timeout or an abort kills the whole
  group, except a descendant that calls `setsid` itself, which survives until the
  sandbox is destroyed.
- **One thread, step by step.** `startThread` (`packages/harness/src/adapters/pi`) loads
  the thread's stored history, builds a Pi `Agent` from it, and records every Pi message
  to `History` at `message_end`, synchronously: if a write fails the agent stops and
  nothing more is stored, so the history is always an exact prefix. Tool calls and results
  go through the run's `recorder` (`src/recorder.ts`): a background queue in emission
  order whose failures never end a thread (events are retried). Live tool output
  (`ToolContext.output`) goes nowhere until the stream hub (PR F). `startThread({prompt, input?})`: a new thread sends
  the prompt; a thread with history sends `input`, or continues if there is none. On
  resume it answers every tool call without a result (appended, never editing history)
  and fails if the stored system message differs from the current prompt and tools. `apps/runner/src/main.ts` wires it to the HTTP client
  (`packages/harness/src/adapters/http`), the Modal sandbox and a model:
  `pnpm --filter @voluma/runner run-task --provider openai --model <id> --task "<text>"`
  (needs `pnpm dev` running, which writes the API's URL and token to `.dev/env.json` for the runner unless `.env` sets `VOLUMA_API_URL`; keys are in `.env`, which the runner reads
  into a config object rather than `process.env`; model keys are `VOLUMA_<PROVIDER>_API_KEY`). The sandbox is
  created on the first `bash` call and destroyed at the end (every exit path, and what a crash
  leaves: `apps/runner/.context/CONTEXT.md`); Ctrl-C kills the running
  command and ends the thread as cancelled; the same `--run` and `--thread` resume it.
  A Claude `refusal` ends the thread as failed with that reason. The `bash` tool lives
  in `packages/harness/src/tools`; it caps what the model sees (head and tail) and
  writes the full text to `toolOutputKey` with `Sandbox.writeFile`, which exists
  because an R2 mount cannot append: the adapter writes locally and copies in one go.
- **Many threads, one run.** `startThread` returns `{send, done}` at once: `send` steers a
  message into the running thread (Pi's steering queue) and answers false once it ended.
  `threads.ts` is the run's thread registry: it starts and resumes threads (another
  `startThread` on the same id, from History) and implements `thread_message`
  (`tools/thread-message.ts`): steer a running target, wake an idle one, `wait` only toward the
  caller's own children. Thread ids must be unique across runs (History is keyed by the
  thread id alone); the supervisor prefixes them with the run id.
- **The checklist is a fold.** `task-runtime.ts` is the only writer of `task`, `checkpoint`,
  `output`, `attempt.opened` and `revision.started` events, under `@voluma/contracts/task-tools`.
  Its only view of the run is `fold(recorder.events())`, refolded for each decision, inside one
  per-run critical section; it waits for each append to be stored (`recorder.emit` resolves
  true) before a tool returns. The recorder keeps the events it emitted for this; a resume
  passes it the stored events (see TODO). `tools/task-tools.ts` wraps it as the model's
  `checklist`, `checkpoint` and `report_output`. `output-checks.ts` holds the declared-output
  and reference checks. Files named as evidence go through the `Evidence` port.
- **The supervisor** (`supervisor.ts`) is code, not a thread with a model: it starts workers for
  ready tasks (`@voluma/workflow`: `readyTasks`, `transitiveDependents`), wakes a stopped worker
  up to `stuckLimit` times, then the stuck guard marks the task, starts a check thread on a
  done or to-check task, and writes the check result. A check that did not pass, or a failed
  thread, is a judgment point: `judgment.ts` is the one seam (`decide(point) → accept | redo |
  fail`), its decisions record `by: judgment(arm)`, and `llmJudgment` is the first arm (one
  fresh structured call per decision). The supervisor never imports Pi; it gets threads, the
  runtime and the judgment from its caller.
- **`seq` and the database.** `seq` per run is gapless and in commit order: each
  append takes a per-run advisory lock as its own statement before the insert (a lock
  inside the insert's statement races under READ COMMITTED), so the stream hub can
  publish after commit and treat a gap as "backfill". `pi_messages.message` is `text`
  because `jsonb` would reorder keys and break byte-for-byte history. Migrations are
  generated Drizzle `.sql` files in `apps/api/drizzle/`, run from one place
  (`apps/api/src/migrate.ts`: `pnpm db:migrate` locally, Railway's pre-deploy step in production), never at server start
  because `migrate()` takes no lock and never with `push`.
- **Where the runner lives.** For now it's a Node process (`apps/runner`)
  that talks to the API. Whether it moves into a Durable Object per run is
  decided after the first real run.

The design, the evidence behind it and the order of work are in the
voluma-bio/docs work item `mvp-contracts-and-data` (`design/harness-v0.md`).

## Authentication

`apps/api/src/auth.ts` authenticates every `/api/*` request once, at the root, and sets
`principal` (`apps/api/src/domain.ts`): `service` for the runner's bearer token
(`VOLUMA_API_TOKEN`), `user` for a WorkOS AuthKit session cookie of a member of an allowed
organization: the Yao Lab (`WORKOS_LAB_ORGANIZATION_ID`, scope `lab`) or, if set, the Judges
organization (`WORKOS_JUDGES_ORGANIZATION_ID`, scope `self`). `org_id` must be in that list,
checked on every request and again in the sign-in callback. The user's `labId` is their
organization and `scope` its entry; domains receive `readerOf(user)` and never branch on
`scope`. `self` has two producers, one per identity source: WorkOS users in the Judges
organization, and anonymous demo visitors, whom our server mints (a sealed cookie, no WorkOS
user, no email) in the demo entrance PR. No WorkOS user signs into a Demo organization, so
none is in the list. WorkOS does not enforce the `organizationId` pin on sign-in, so the
per-request allow-list is the only control. `scope` is server-internal: `/me` returns only the contract shape. When an `Authorization` header is present only the
bearer counts. The root answers 401 for no principal on everything but `/api/auth/*`;
a domain guards a subtree with `requireService` or `requireUser` (which also sets a typed
`c.var.user`) and gets 403 for the other kind. A cookie-authenticated non-GET request must
carry an `Origin` equal to `APP_URL`'s origin (`SameSite=Lax` is same-site, not
same-origin) and a JSON content type; a WebSocket upgrade must carry the `Origin` only.
Bearer requests are exempt. `APP_URL` (the Vite origin in `pnpm dev`, the public URL in
production) is config, never the `Host` header: it builds the redirect
`${APP_URL}/api/auth/callback`. There is no `users` table: records store the WorkOS user id.

Routes: `GET /api/auth/login?returnTo=`, `GET /api/auth/callback`,
`POST /api/auth/logout` (returns `{ logoutUrl }` for the browser to navigate to),
`GET /api/auth/me`. A non-member is sent to `/?signin=not-a-member`, a failed callback to
`/?signin=failed`; both leave no session cookie.

The root mounts in this order: bearer and CSRF (no I/O, so a forged request makes no
WorkOS call); login, callback and logout, the only writers of the session cookie (they
authenticate through PKCE and state, or need only the cookie, not a refresh); the session
cookie and the 401 for no principal; then `/me` and the domains. That order, not a check
after the response, is what gives the cookie one writer. A refreshed session comes back as
`Set-Cookie` on the response that triggered the refresh.

A request makes at most one WorkOS refresh (`AuthKitCore.validateAndRefresh`), with a 3 s
timeout and no SDK retries (AuthKit's own one-time 429 retry stays, so a rate-limited
refresh is two calls). The JWKS fetch has the same 3 s bound and its keys are kept for the
process lifetime (an unknown `kid` reloads, behind jose's 30 s cooldown), so a cold process
during an outage spends at most 3 s on keys plus 3 s on the refresh. Each process also
remembers refresh outcomes in a 10k-entry LRU keyed by the refresh token: a
refreshed session until its access token expires, a dead one until the cookie's max age, a
transient failure for 10 s. A
client replaying one cookie therefore costs one WorkOS call per access-token lifetime, or
none once the session is dead; the allow-list is still checked on every request. A failure
that is 408, 429, 5xx or a network error leaves the cookie, is remembered for 10 s (a
replay in that time makes no WorkOS call), and answers
503 `{ "error": "auth unavailable" }` (not 401, which signs the web client out), so an
outage shows the gate's can't-be-reached screen and keeps the session; any other failure (revoked or expired session,
`sso_required`) clears it, and an unreadable cookie is cleared without a call.

Sign-out revokes the session at WorkOS on the server (`userManagement.revokeSession`), as
does signing in over an existing session (the old one); refresh tokens are not rotated on
use, so a copied cookie would otherwise stay a session. Sign-out refuses copies of the
cookie at once in the process that handled it (its memo marks the refresh token dead, and
a refresh already in flight cannot undo that); in another process, or after the memo
evicted the entry, a copy works until its access token expires (5 min on staging) and is
refused at its next refresh. `returnTo` is sanitized, limited to printable ASCII and 512
characters, and dropped if it doesn't fit, which keeps a PKCE verifier cookie near 1.2 KB;
`/login` evicts stale verifier cookies.

## Deployment

Staging is one Railway service, `@voluma/api`, plus Railway Postgres: the API serves the
built web app and `/api/*`, and a merge to `main` deploys it. Setup, variables, secret
rotation: [apps/api/.context/deploy.md](../apps/api/.context/deploy.md).

## Packages export source

Every package's `exports` points at `src/*.ts`. There is no build step
between packages: Vite and `tsc` read the source directly, so an edit in a
package shows up in the app at once. Packages get a build only if something
outside the workspace consumes them.

## Checks

`pnpm check` runs Biome over the whole repo, then `nx run-many -t typecheck
test`. Nx caches each package's typecheck and test against its inputs and
its dependencies' inputs, so an unchanged package costs nothing on the next
run. Nx config is target defaults and caching only. A package joins
`typecheck` or `test` by having that script in its `package.json`.

Import boundaries are written rules in `AGENTS.md`; Biome uses its recommended rules.

## Theming

`tokens.css` defines semantic custom properties under `:root` and
`[data-theme="light"]`, and again under `[data-theme="dark"]`. `theme.css`
maps them into Tailwind with `@theme inline`, so a utility reads the token
where it is used and `data-theme` on any element themes its subtree. That is
how `/dev/ui` shows both themes side by side. Review now selects light, following
Andrew's implementation direction. Tailwind's default palette is removed.

The token names are shadcn/ui's (`background`, `card`, `muted`, `accent`,
`primary`, `destructive`, `border`, `ring`, `chart-*`, `sidebar-*`), with
shadcn's meanings and our palette as the values, so a shadcn component copied
into the repo works unchanged. Note `accent` is shadcn's hover fill, not the
brand green: that is `primary` (with `primary-tint`, `primary-strong`,
`primary-text`). Tokens shadcn has no name for keep ours (`check-*`, `info*`,
`inverse*`, `scrim`, `fg-subtle`, `line-subtle`, `line-strong`, viewer and axis
tokens). Add a colour to `tokens.css` and `theme.css` together.

The viewer's colours (axes, bone, rulers, labels) are tokens too. Canvas and
WebGL code reads them with `getComputedStyle` rather than copying values, so
the CSS stays the one source.

## Review integration

The Review UI is in `apps/web/src/features/review`; persistent view slots are
in `packages/viewer`. There is one Review route, `/runs/:runId`, with no demo
route. The local workspace uses `runId=local` without creating a server run.
No synthetic measurements or simulated services are mounted.

`features/review/report/model.ts` is a presentation model, not the shared API
contract. Reports, revision selection and command UI remain available for the
real adapter; until it exists the workspace shows explicit empty states. Shared
contracts and API client are unchanged from main. Report/viewer splits retain
react-resizable-panels to preserve the verified nested maximize/restore behavior;
the unrelated shared `SplitPanel` API and `/dev/ui` remain unchanged.

Local DICOM intake and rendering work without the API. They do not populate
analysis results or create server runs. The [Review specification][review-spec]
describes the UI seam; the [viewer specification][viewer-spec] describes input
support, geometry, limits, library integration and verification coverage.

[review-spec]: ../apps/web/src/features/review/.context/CONTEXT.md
[viewer-spec]: ../packages/viewer/.context/CONTEXT.md

## Parallel agents

Several agents from two people work at once, each in its own worktree.
Nothing they run shares mutable state:
- `pnpm dev` (`tools/dev.mjs`) picks two free ports for the API and Vite (`--strictPort`,
  `/api` proxied to the API), gives the worktree its own database `voluma_<directory name>_<hash of its path>`
  on the Postgres server in `DATABASE_SERVER_URL` (`pnpm db:up` starts one container,
  `voluma-pg` on port 54432, shared by all worktrees as a server only), migrates it, and
  writes `.dev/env.json` (git-ignored) for the runner. `.env` holds nothing per worktree;
  the API token is generated per launch (`pnpm db:reset` drops the worktree's database);
- Nx keeps its cache in the worktree's `.nx/` and runs without a daemon;
- sandboxes are named `<runId>.<name>` and tagged with the run id, so give each
  worktree's runs their own run ids; the event log is in the worktree's own
  database;
- the pnpm store is shared, but it is content-addressed and append-only.

The pre-commit hook lives in the shared `.git`, so every worktree runs the
same hook.
