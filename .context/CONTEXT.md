# Repo architecture

How the workspace fits together and why it is set up this way. Rules and
commands are in [AGENTS.md](../AGENTS.md).

## Shape

```
apps/web        React + Vite. shell/ mounts routes and the `AppShell` frame (one `QueryClient` in `SignedIn`; no top bar); features/study (Home, studies, Workflows) and features/scan (the scan review) own screens
apps/api        Node server on Postgres (Drizzle), each domain a Hono app. src/index.ts is the
                composition root: the only code that reads env; it builds the adapters and
                mounts domains/run at /api/run/ (runs, the queue, the event log) and domains/review at
                /api/review/ (review data, corrections) with app.route. A
                domain's tables and Postgres adapters live in the domain; adapters/ is for
                shared ports
                Sign-in: see Authentication
apps/runner     The runner service: claims runs from the API and runs the run loop on each (Run lane)
packages/
  contracts     zod schemas for the four contracts and the shared formats; the fold (a row per plan task, stale-task graph)
  harness       the agent harness: our tools, the Sandbox and EventLog ports, the Pi
                adapter; runtime-neutral (no Node types)
  workflow      a workflow skill directory: snapshot it into the run's R2 prefix and read it (`load.ts`), build the plan from the selected outputs (`plan.ts`)
  api-client    typed commands and event stream; the only way web features reach the API
  viewer        the grid viewer (three.js, zarr in a worker) and the grid a review task is shown on
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
threads: a supervisor (the root, code), the main agent, workers (one per task),
and check threads.
- **Event log.** Ours, kept separately from Pi's history: the `events`
  table in Postgres, behind the run domain's API, keyed `(run_id, id)`. Each event is saved
  before it is published, and `seq` (per run) is the stream cursor. Both the
  UI and the review read this log. Pi's own messages go in `pi_messages`,
  one row per message, keyed `(run_id, thread_id, idx)`, so a thread can resume.
- **Sandboxes.** One Modal sandbox per sandbox, CPU or GPU, created by the Node
  runner through the `Sandbox` port (`packages/harness/src/ports/sandbox.ts`); the
  adapter is `apps/runner/src/modal-sandbox.ts`, the only file that imports `modal`
  (pinned: the JS SDK is pre-1.0). It mounts R2 prefixes that don't overlap: the
  workflow and the inputs read-only, the run's scratch and outputs read-write. Each
  mount gets its own temporary R2 credential, limited to its prefix and the sandbox's
  lifetime, minted from `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_BUCKET` and `CLOUDFLARE_API_TOKEN`; the credentials never enter
  the sandbox. Inputs are copied to local disk at their mount path at create for the threads of a task whose `tasks.json` entry sets `copyInputs` (decisions 2026-10-30) (a cold
  mounted read of the scan is slow; see the POC in the docs repo, `research/modal-poc.md`);
  the bucket is mounted privately for the copy. Each sandbox gets a fresh name (Modal
  names are unique among running sandboxes, so a sandbox a dead runner left behind
  would block a resume). `packages/harness/src/layout.ts` owns which prefix is mounted
  where; prompts and tools take paths from it.
  There is no internet. The image is a public GHCR image pinned by digest (`SANDBOX_IMAGE` in
  `apps/runner/src/config.ts`), built by the "Sandbox image" workflow from
  `apps/runner/sandbox/Dockerfile`, which installs `workflows/core/requirements.txt`,
  so every sandbox, a visitor's too, pulls the same one. Every command runs
  under `timeout -k`, which leads its own process group,; a timeout or an abort kills the whole
  group, except a descendant that calls `setsid` itself, which survives until the
  sandbox is destroyed.
- **One thread, step by step.** `startThread` (`packages/harness/src/adapters/pi`) loads
  the thread's stored history, builds a Pi `Agent` from it, and records every Pi message
  to `History` at `message_end`, synchronously: if a write fails the agent stops and
  nothing more is stored, so the history is always an exact prefix. Tool calls and results
  go through the run's `recorder` (`src/recorder.ts`): a background queue in emission
  order whose failures never end a thread (events are retried). Live tool output
  (`ToolContext.output`) streams as live frames (`bash.ts`). `startThread({prompt, input?})`: a new thread sends
  the prompt; a thread with history sends `input`, or continues if there is none. On
  resume it answers every tool call without a result (appended, never editing history)
  and fails if the stored system message differs from the current prompt and tools. `apps/runner` wires it (see "The runner service" below).
  The sandbox is created on the first `bash` call and destroyed at the end (every exit path, and what a crash
  leaves: `apps/runner/.context/CONTEXT.md`). A Claude `refusal` ends the thread as failed with that reason. The `bash` tool lives
  in `packages/harness/src/tools`; it caps what the model sees (head and tail) and
  writes the full text to `toolOutputKey` with `Sandbox.writeFile`, which exists
  because an R2 mount cannot append: the adapter writes locally and copies in one go.
- **Many threads, one run.** `startThread` returns `{send, done}` at once: `send` puts a
  message in the thread's inbox and answers false once it ended. Every notice to a thread
  (a message from a person or another thread, compaction's wrap-up and overflow notes) waits
  in that inbox. All pending notices, in arrival order and each labelled with its sender, are
  appended to the last tool result of the batch that finishes next, so History holds what the
  model saw; none is ever steered in as its own user message mid-turn. A turn that ends with
  no tool call while the inbox holds notices continues with them as one user message; a
  thread started with an input starts with them the same way; the wrap-up note, which only
  matters mid-turn, is dropped in both. Each notice is still its own `message` event under
  its own sender.
  `threads.ts` is the run's registry of what is running in this process (start or resume a
  thread, `send`, `abort`, wait for one to go idle) and holds no run state. A thread's id is opaque, unique within its run
  only (every row and query is keyed by run): a new thread gets `uuid5(runId, name)`
  (`packages/harness/src/thread-id.ts`), minted once when it first starts. Its `name` (`supervisor`,
  `main`, `<taskId>.<role>`, plus `.<n>` for the n-th) is on `thread.started`, where n is how many the
  log has started for that role, so a restart never reuses a thread. Everything after the mint reads
  the id from the record; runs recorded before keep their `<runId>.<name>` ids, and a run's root is
  looked up in its log (`rootThreadOf`), never rebuilt. `thread.started` carries the task id
  for a worker or check thread.
- **Pi's batch rules shape the tools.** Pi runs the tool calls of one reply as a batch: in
  parallel, unless any tool in it is `sequential`, which makes the whole batch sequential. A
  batch ends the turn only when every result in it sets `terminate`; one call that doesn't and
  the agent carries on. An inbox delivery lands with the last result of a batch, never
  between its calls. So a tool that must end the turn (`submit_task`, `ask`) refuses to share a
  reply (`ToolContext.batchSize`): it answers with an error result and no effect, the other calls
  run as usual, and the model calls it again alone; `wait` ends the main agent's turn instead of blocking until
  something happens, because a blocking `wait` would hold every sequential call batched behind it
  and no inbox delivery could reach it; and a stored history whose last batch all set
  `terminate` is a finished turn, not one to continue (`isFinished` in `start-thread.ts`). Pi
  does not settle a tool call that ignores its abort signal (`ToolContext.signal`), and the thread
  cannot stop until every call settles, so a tool passes the signal on to whatever it waits for.
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
  which waits for the store's acknowledgement (retried like `emit`, safe because the store ignores an
  event id it holds), so the runtime never decides from an event the store lacks; a store
  that refuses the event fails the tool call, and the run loop fails the run. A store still
  unavailable after the retries releases the run instead (the runner's "self-stop"). Hashing and copying
  evidence happen outside the section. A worker writes only to its own task, and an attempt
  opens only when every task it builds on is satisfied (`openAttempt` is the one way).
  `tools/task-tools.ts` wraps it as `checkpoint`, `report_output`, `submit_task` and `ask`. `output-checks.ts` holds the
  declared-output, reference, grid-placement and ruler-length checks. Files named as evidence go through the `Evidence` port.
- **The run loop** (`run-loop.ts`) is code, not a model thread, and keeps no state of its own. Each
  step, inside the runtime's `section`, is a function of `fold` of the log, `thread-log.ts` (every
  thread's state: running, idle, stopped, cut off; asks and answers; fix rounds; the delivery
  cursor and notices) and which threads run in this process. It does the first applicable of:
  resume a cut-off thread, start the check of an `under-review` task, write a finished check's
  result (`check-result`, or `fix-limit`), deliver to the main agent, and the liveness end. Resume is the same code as a first run. The run ends when
  the root has a completed `thread.ended` (`finish_run`, or liveness); then every thread without
  an end is stopped. Stops are appended first (`thread.ended {cancelled}` inside the section,
  then abort without waiting), so the holder check refuses the stopped thread's next write at once.
  A stale mark stops every worker and check of the dependent the same way, whatever its status.
  A `message` that opens an attempt for feedback is followed by the worker's copy of the text; if a
  cut falls between, the loop resumes the idle holder with the text stored in the `message` call.
- **The main agent** (name `main[.n]`, kind `main`) is the one model thread that coordinates:
  it starts workers (`start_agent`), steers them or sends feedback on a rejected task
  (`message`), answers a checker (`answer`), accepts a rejected task, changes the plan
  (`change_plan`, recorded as `plan.changed` before it applies) and ends the run
  (`finish_run`). Its tools are `tools/main-tools.ts`; each writes under an id derived from the
  call (`tools/effects.ts`), so a call a crash cut off is answered from the log. It hears about
  the run only through **delivery messages** that resume it: the notices (a submit, a worker that
  stopped, a check result, an `ask`, a stale task), the live agents and the tasks whose row
  changed (`messages.ts`, which holds every string an agent is told). A delivery's `covers` is the last event it accounted for; what lies
  after the latest `covers` is undelivered, so a crash can deliver twice, never lose one. If the
  main agent ends its turn with nothing running and nothing to deliver, it is nudged with the full
  agents list and task table; after `stuckLimit` such nudges in a row code skips the unfinished
  tasks (a root-written `plan.changed`) and ends the run. A main thread that cannot resume, or
  failed on a provider error, is replaced by `main.<n+1>` whose first message is built from the log.
  A thread that throws or is refused before it starts (`ran` false), a fatal provider error (a retryable one resumes its thread once first), or an
  error in a step fails the run: threads aborted, the root ends `failed`. The loop never imports
  Pi; `superviseRun` (`packages/harness/src/supervise-run.ts`) wires it, and a host gives only
  what holds keys and machines (the stored record, a model per thread, `createSandbox`, the gateway's token). The harness writes each role's tools, system prompt and first message from the workflow definition (`prompts.ts`) and each sandbox's spec from its layout.
  The harness builds exactly the tools a role's file names (`tools/registry.ts`).
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
  exits. A `voluma` run uses our model key; a `visitor` run uses the claim's Meta key, in that run's scope
  only. Every sandbox runs on our Modal token. A guest may start only `visitor` runs (403 otherwise). `redact.ts` masks every literal key in stored events and history rows, console lines
  (redacted before they are clipped) and the report's `error`. Before a run's sandbox exists the runner snapshots `workflows/core/` and the run's workflow directory (`workflows/<name>/`) from its own checkout into the run's R2 prefix, once per run, and reads the snapshot (`packages/workflow`). The plan is the tasks that produce the outputs the user selected (`Run.selectedOutputs`, all if absent) and what they depend on, built from `tasks.json` and `outputs.json` (`computePlan`) and recorded in the first event (the main agent changes it later with `change_plan`); a resumed run keeps the plan its first event recorded. The prompts are the harness's role prompts plus the skill list (name, description, `/workflow/...` path; the agent reads the rest with bash) and the task's instructions and done criteria (`prompts.ts`). Every role's tools are what its role file lists (`workflows/core/agents/`), built from the registry (`packages/harness/src/tools/registry.ts`); `segment_sam` runs `voluma-sam` in the worker's sandbox through the gateway, so it needs `VOLUMA_GATEWAY_URL` and is never granted to the checker. The claim carries no plan. Workflow format: voluma-bio/docs `work/mvp-contracts-and-data/design/workflow-format.md`.
- **`seq` and the database.** `seq` per run is gapless and in commit order: each
  append takes a per-run advisory lock as its own statement before the insert (a lock
  inside the insert's statement races under READ COMMITTED), so the stream hub can
  publish after commit and treat a gap as "backfill". `pi_messages.message` is `text`
  because `jsonb` would reorder keys and break byte-for-byte history. Migrations are
  generated Drizzle `.sql` files in `apps/api/drizzle/`, run from one place
  (`apps/api/src/migrate.ts`: `pnpm db:migrate` locally, Render's pre-deploy command in production), never at server start
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

**Guests.** With `GUEST_ORGANIZATION_ID` (and `GUEST_SCOPE`, `self` or `lab`, default `self`) set, a request with no session cookie, no bearer and a valid guest cookie
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

Staging runs on Render (region Virginia), defined in `render.yaml`: the API
(`voluma-api`, which serves the built web app and `/api/*`), the gateway, the runner (suspended between runs after 2026-11-04) and,
outside Render, Postgres on Neon's free tier. A merge to `main` deploys each service whose build filter it touches. Setup,
variables, secret rotation: [apps/api/.context/deploy.md](../apps/api/.context/deploy.md).

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
how Storybook shows both themes side by side. The app uses light chrome on home, study
and scan review; the 3D and slice image wells stay dark. Tailwind's default palette is removed.

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

## Scan review

One scan's run, live and for review, is `apps/web/src/features/scan` at `/scans/:runId` (light chrome, dark image wells),
with the selection in the URL (`task`, `item`, `agent`); the old `/runs/:id/live` and
`/runs/:runId` redirect there. It reads the run's stream for tasks, agents, items and the
conversation, and the review payload (`getReviewRun`) for what the viewer draws, values and
files. What any screen needs to show a run is `packages/run-view`; the grid viewer is
`packages/viewer`. No synthetic measurements or simulated services are mounted.

Images come only from the run: each task's grid and what is drawn on it are the run's published
blocks and converted assets. The [scan review specification][scan-spec] covers the URL, the two
sources and reconnecting; the [run view specification][run-view-spec] the run model and
transcripts; the [viewer specification][viewer-spec] how a task's grid is chosen, the viewer's
geometry, loading and verification coverage.

[scan-spec]: ../apps/web/src/features/scan/.context/CONTEXT.md
[run-view-spec]: ../packages/run-view/.context/CONTEXT.md
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
- The API reloads through `tsx watch`, which ignores `node_modules`, with explicit
  includes for `apps/api/src/**` and `packages/*/src/**`. Do not use Node's import-graph
  `--watch`: pnpm installs and worktree removal change shared dependency hardlinks
  and can restart another worktree's API;
- Nx keeps its cache in the worktree's `.nx/` and runs without a daemon;
- sandboxes are named `<runId>.<name>` and tagged with the run id, so give each
  worktree's runs their own run ids; the event log is in the worktree's own
  database;
- the pnpm store is shared, but it is content-addressed and append-only.

The pre-commit hook lives in the shared `.git`, so every worktree runs the
same hook.

## Amp orb preview

Amp supplies `voluma-bio/docs` and `voluma-bio/voluma-legacy` as additional
repositories in `../repos/`. `.agents/resume` fetches both repositories' origin
branch refs after initial activation (including cached snapshots) and every
wake, then fast-forwards only clean `main` checkouts without local commits or
an in-progress Git operation. Dirty files (including untracked files), other
branches and detached HEADs are left alone. The primary checkout stays under
Amp's control; the hook never switches or updates the agent's working branch.
Ignored local files also survive: if an incoming tracked path would overwrite
one, the fast-forward aborts and prints a warning. Nonconflicting ignored files
do not block the refresh.

The two fetches run concurrently, each with an 8-second timeout and a 1-second
kill grace. A failed fetch leaves files unchanged and prints a warning; it does
not prevent the other repository from refreshing. Check
`~/.cache/amp/logs/resume.log` for status and rerun `.agents/resume` to retry or
refresh during a long session. Amp waits only 10 seconds for resume; a slow
checkout can finish after the agent starts. This is a start/wake refresh, not
a hook on arbitrary `git fetch` commands. Git has no general post-fetch hook.
Pre-clone and pre-setup project scripts do not run on every wake, and setup
lacks personal GitHub credentials, so refresh belongs in resume. Existing
orbs on older branches must pick up this hook before they gain the behavior.
Lifecycle reference: [Customizing Orbs](https://ampcode.com/docs/orbs/customizing).

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
