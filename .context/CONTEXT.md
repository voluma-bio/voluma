# Repo architecture

How the workspace fits together and why it is set up this way. Rules and
commands are in [AGENTS.md](../AGENTS.md).

## Shape

```
apps/web        React + Vite. shell/ mounts routes; features/run and features/review own screens
apps/api        Node server on Postgres (Drizzle), each domain a Hono app. src/index.ts is the
                composition root: the only code that reads env; it builds the adapters and
                mounts domains/run at /api/run/ (runs, the queue, the event log) and domains/review at
                /api/review/ (review data, chat threads, corrections) with app.route. A
                domain's tables and Postgres adapters live in the domain; adapters/ is for
                shared ports
                Sign-in: see Authentication
apps/runner     The runner service: claims runs from the API and runs the supervisor on each (Run lane)
packages/
  contracts     zod schemas for the four contracts and the shared formats
  harness       the agent harness: our tools, the Sandbox and EventLog ports, the Pi
                adapter; runtime-neutral (no Node types)
  workflow      a workflow skill directory: snapshot it into the run's R2 prefix and read it (`load.ts`), build the plan from the selected outputs (`plan.ts`), task graph, stale tasks
  api-client    typed commands and event stream; the only way web features reach the API
  viewer        in-browser DICOM ZIP parsing, Cornerstone acquired slices, persistent imaging slots
  ui            shared React components, styled from tokens
  design-tokens tokens.css (raw values, two themes) and theme.css (Tailwind mapping)
workflows/      `core/` (role files, generic micro-CT skills, Python requirements) and one directory per workflow (`outputs.json`, `tasks.json`, `skills/`), with their Python skill resources
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
  There is no internet. The image is a public GHCR image pinned by digest (`SANDBOX_IMAGE` in
  `apps/runner/src/config.ts`), built by the "Sandbox image" workflow from
  `apps/runner/sandbox/Dockerfile`, which installs `workflows/core/requirements.txt`,
  so a visitor's Modal workspace pulls the same one. Every command runs
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
  and fails if the stored system message differs from the current prompt and tools. `apps/runner` wires it (see "The runner service" below).
  The sandbox is created on the first `bash` call and destroyed at the end (every exit path, and what a crash
  leaves: `apps/runner/.context/CONTEXT.md`). A Claude `refusal` ends the thread as failed with that reason. The `bash` tool lives
  in `packages/harness/src/tools`; it caps what the model sees (head and tail) and
  writes the full text to `toolOutputKey` with `Sandbox.writeFile`, which exists
  because an R2 mount cannot append: the adapter writes locally and copies in one go.
- **Many threads, one run.** `startThread` returns `{send, done}` at once: `send` steers a
  message into the thread (Pi's steering queue; one sent before the loop starts is queued
  for it) and answers false once it ended.
  `threads.ts` is the run's registry of what is running in this process (start or resume a
  thread, `send`, `abort`, wait for one to go idle) and holds no run state. `thread_message`
  (`tools/thread-message.ts`) calls the supervisor's `message`: steer a running thread, or
  wake an idle one whose task is waiting on it. `wait` is refused until a thread can start
  children. Thread ids are unique across runs (History is keyed by the thread id alone) and
  follow `@voluma/contracts/ids`: the root is `<runId>.supervisor`, the others
  `<runId>.<taskId>.<role>` (plus `.<n>` for the n-th), where n is how many the log has started
  for that task and role, so a redo never reuses a thread. `thread.started` carries the task id
  for a worker or check thread.
- **The log is the run.** `recorder.ts` has one ordered delivery queue for `emit` and
  `append`, and an event joins the view (`events()`) only once the store has acknowledged it, in
  delivery order. The view is always a prefix of the store, so `recorder(..., stored)` on a
  resume holds exactly the view the run had. A retrying `emit` holds back every later event,
  because nothing should be decided past a gap in the record.
- **The checklist is a fold.** `task-runtime.ts` writes the `task`, `checkpoint`, `output`,
  `attempt.opened` and `revision.started` events a thread's tool call causes, under
  `@voluma/contracts/task-tools`. Its only view of the run is `fold(recorder.events())` (folded
  once per change of the log), inside one per-run critical section (`section`). A thread's
  kind and task come from its tool context, not the log. It writes through `recorder.append`,
  which makes one attempt, so the runtime never decides from an event the store lacks; a
  store failure fails the tool call, and the supervisor fails the run. Hashing and copying
  evidence happen outside the section. A thread writes only to its own task, and a worker
  opens an attempt only when every task it builds on is done. `tools/task-tools.ts` wraps it
  as the model's `checklist`, `checkpoint` and `report_output`. `output-checks.ts` holds the
  declared-output and reference checks. Files named as evidence go through the `Evidence` port.
- **The supervisor** (`supervisor.ts`) is code, not a thread with a model, and keeps no state
  of its own. Each step, inside the runtime's `section`, is a function of `fold` of the log, the
  thread records read from the same log (started, ended, wakes, judgments) and which threads
  run in this process; the header lists the rule per task status. Resume is the same code as a
  first run: a new process given the stored events and History starts nothing twice, wakes a
  thread the dead process left running, and names a redo's worker from the log's count. A
  task whose check passed has a boundary wake; a check that did not pass, or a failed thread,
  is a judgment point. Both wake **the main thread** (`main-thread.ts`): one model thread per
  run, kept as a conversation rebuilt from the log (the `wake` events), never held in memory,
  so it is append-only (a provider's prompt cache keeps hitting its prefix) and a resumed run
  asks from the context the first run had (each wake names the model that answered; a resume
  may use another). The run's first wake, `run-started` (`run-start.ts`, from `superviseRun`
  before the task runtime exists), may adapt the computed plan to the user's notes: no notes,
  no call. The model answers only a change (done-when lines to append, workflow tasks to add)
  and code builds the plan from the workflow files (`adaptPlan`), so outputs, units, ranges and
  required-ness cannot change; a bad answer is recorded as an `error` and the computed plan runs;
  `revision.started.plan` stays the record of what applied. A stop during that wake leaves no
  `revision.started` (the supervisor skips `runtime.start()`), so a resume asks again. Every
  wake sees the selection and computed plan (in the system prompt), and every worker and
  check thread gets the user's notes verbatim in its first message, beside the main thread's.
  Each wake is one call, asked outside the section and bounded by a deadline and the abort
  signal (a stop is no answer and records nothing). It answers with the whole notes block (at
  most `WAKE_NOTE_MAX` characters) and, at a judgment point, `accept | redo | fail`. The
  answer is written as a `wake` event `<thread>@<starts>:wake` (the start count lets a
  re-woken thread have a second wake) before anything uses it; the next step turns a judgment
  point's decision into the `judgment` event `<thread>:judgment` (arm `main:<provider/id>`; the
  fallback when the call errored or a redo was capped) and applies it, as `by: judgment(arm)`.
  A replay finds both and asks no one. The notes in force (the latest `wake` with a `note`) go
  into the first message of every worker and check thread started after, never a system
  prompt. Context grows by one wake message (the task's report) and one answer (the notes
  block, rewritten whole) per wake: about 0.3 k tokens each on a probe run with short
  reports, at most ~1.5 k for a full-length note. A 10-task run with a few judgments is ~13
  wakes: 5 to 25 k tokens at the end, and every wake after the first re-reads the earlier
  ones from the cache.
  The main thread has no tools or sandbox yet (`apps/runner/.context/TODO.md`). A thread that throws or is refused before it starts (`ran` false), or an
  error in a step, fails the run: threads aborted, the root ends `failed`. The supervisor never
  imports Pi; it is built by `superviseRun` (`packages/harness/src/supervise-run.ts`), which a host gives only adapters.
- **The runner service** (`apps/runner`, `pnpm --filter @voluma/runner start`). It polls
  `claim` while it has a free slot (`RUNNER_CONCURRENCY`); `run.ts` runs each claim the same
  way whether the run is fresh or recovered: read the run's stored events (paged) and every
  thread's history over HTTP, build the recorder from them, and call the harness's `superviseRun` with the sandbox,
  evidence and model adapters. All run-scoped HTTP (events, history, heartbeat, report) is one
  `runClient`, which also stops the run on a lost lease and redacts what it sends. `lease.ts` heartbeats every 15 s with the
  usage since the last acknowledged one (model dollars from Pi's per-reply cost, sandbox
  seconds from the session's ready/stopped states) and stops the run on `stop`, on a
  `LeaseLost` from events, history or heartbeat, or 45 s after the last acknowledged
  heartbeat was sent. SIGTERM stops every run, each reports `released`, and the process
  exits. A `voluma` run uses our keys; a `visitor` run uses the claim's, in that run's scope
  only. `redact.ts` masks every literal key in stored events and history rows, console lines
  (redacted before they are clipped) and the report's `error`. Before a run's sandbox exists the runner snapshots `workflows/core/` and the run's workflow directory (`workflows/<name>/`) from its own checkout into the run's R2 prefix, once per run, and reads the snapshot (`packages/workflow`). The plan is the tasks that produce the outputs the user selected (`Run.selectedOutputs`, all if absent) and what they depend on, built from `tasks.json` and `outputs.json` (`computePlan`), passed through `adaptPlan` (where the main thread will adapt it to the run's notes) and recorded in the first event; a resumed run keeps the plan its first event recorded. The prompts are the harness's role prompts plus the skill list (name, description, `/workflow/...` path; the agent reads the rest with bash) and the task's instructions and done criteria (`prompts.ts`). Every role's tools are `view_image` and, with a Meta key, `segment_sam`, built from the registry (`packages/harness/src/tools/registry.ts`). The claim carries no plan. Workflow format: voluma-bio/docs `work/mvp-contracts-and-data/design/workflow-format.md`.
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
(`VOLUMA_API_TOKEN`) or the optional read-only debug token (`VOLUMA_DEBUG_TOKEN`, every lab's
runs, for agents debugging a run), `user` for a WorkOS AuthKit session cookie of a member of an allowed
organization: the Yao Lab (`WORKOS_LAB_ORGANIZATION_ID`, scope `lab`) or, if set, the Judges
organization (`WORKOS_JUDGES_ORGANIZATION_ID`, scope `self`). `org_id` must be in that list,
checked on every request and again in the sign-in callback. The user's `labId` is their
organization and `scope` its entry; domains receive `readerOf(user)` and never branch on
`scope`. `self` has two producers, one per identity source: WorkOS users in the Judges
organization, and anonymous demo visitors, whom our server mints (a sealed cookie, no WorkOS
user, no email) in the demo entrance PR. No WorkOS user signs into a Demo organization, so
none is in the list. WorkOS does not enforce the `organizationId` pin on sign-in, so the
per-request allow-list is the only control. `scope` is server-internal: `/me` returns only the contract shape.

**Guests.** With `GUEST_ORGANIZATION_ID` (and `GUEST_SCOPE`, `lab` or `self`, default `lab`; the
Demo org runs `self`) set, a request with no session cookie, no bearer and a valid guest cookie
is a guest: a `user` principal with `account: "visitor"`, no email, and that organization and
scope, so domains and `readerOf` treat it like any member. Its id (`guest_…`) is minted by
`POST /api/auth/guest` (same-origin, behind the CSRF guard; it returns the `/me` body) into its
own sealed cookie (`voluma-guest`, `__Host-` on https, HttpOnly, 400 days; same seal as the
session cookie, no WorkOS call). A GET or a 404 never mints. The web gate calls it when `/me`
is a 401; a server with guests off answers 404 and the gate shows the sign-in screen. A session
cookie that is refused is cleared and answered 401, never turned into a guest: the gate then
re-loads, and lands on a guest or the sign-in screen. `/me` returns `kind: "visitor"`. Unset
means the sign-in wall, and a guest cookie is ignored. `createAuth` throws when the guest
organization is a member organization. There is no per-visitor mint limit: every cap is per
org. Guests belong to the Demo organization, never the Yao Lab: lab data is the lab's to
share, run by run, so it is for signed-in members; public examples are seeded into the Demo
organization instead. They share the Demo workspace
but each sees only their own runs (`self`). When an `Authorization` header is present only the
bearer counts. The root answers 401 for no principal on everything but `/api/auth/*`;
a domain guards a subtree with `requireService` (the runner) or `requireUser` (which also sets
a typed `c.var.user`) and gets 403 for the other kind; a run read takes `requireReader` on its
route, which reads through the user's `readerOf` or, for the read-only debug token
(`VOLUMA_DEBUG_TOKEN`), every lab. A cookie-authenticated non-GET request must
carry an `Origin` equal to `APP_URL`'s origin (`SameSite=Lax` is same-site, not
same-origin) and a JSON content type. No GET changes app state. Nothing upgrades to
WebSockets (run streams are planned as server-sent events, plain GETs, in #28); a route that
ever accepts an upgrade must add the `Origin` check for upgrades back to the CSRF guard.
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

## Amp orb preview

`.agents/setup` installs and enables native Postgres on loopback port 5432,
with a local-only `voluma` role that can create each worktree's database.
`.amp/services.yaml` declares the guest-only Review preview through `pnpm dev`;
Amp supervises it across restarts and pause/resume. `amp orb services ensure`
starts it explicitly; opening its Portal link also starts it when needed.

In a managed portal, `tools/dev.mjs` uses Amp's allocated `PORT` for Vite and
`PUBLIC_URL` for the API's strict Origin check and secure session cookie. The
API keeps its own free port. `/api` and `/health` proxy through Vite to the API;
the service health check waits for the API, not just the frontend. Outside a
portal, both ports remain dynamically allocated as before.

The preview mints guest sessions locally; its WorkOS placeholders cannot sign
in members. The cookie key is generated at service start, never saved in a
snapshot. R2 values come from Amp project secrets and environment variables,
never the service manifest. Missing R2 configuration blocks scan opening with a
setup error; there is no local-file fallback. No runner, model calls or analysis
jobs start with the preview.
