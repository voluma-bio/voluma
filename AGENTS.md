# Voluma Plat — Agent Instructions

> **Greenfield.** There are no real users and no production data. Delete code you
> don't need, change schemas freely, and never add a compatibility shim. Write
> migrations as if production data exists: no data loss, online-safe DDL, and no
> steps that rely on empty tables.

## Mission

**Scientists should spend their time on their research, not analysis software.**
Voluma takes everything between the raw data and the publication — and makes every
result provable. Every architectural and product decision should survive the
question: *does this help a researcher trust and publish their result?*

We want the code right so that change stays easy: this is an exploratory state, no
backwards compatibility is required, and carrying cost is a bug.

## Engineering principles

**Fix structural debt in the same PR.** Do not defer parallel hierarchies, leaking
abstractions, shallow modules, split ownership, or obvious simplification.

**Library quality.** Interfaces and design patterns are what make software easy to
change. Think as if every module were its own open source library: clean interfaces,
well commented, simple to use from the outside.

**Names are important.** If we rename something, rename it exhaustively — dangling
variables, interfaces, and docs rot shared understanding. `/shared-dao` is important.

**DRY: one source of truth.** Before implementing something new, stop and search, or
spawn `meridian -a explorer`. Two implementations of one idea confuse people and
confuse agents more.

**Agency.** Act on confident inferences. Do not ask permission to refactor, delete
dead code, or simplify.

## Conventions

**Layering.** Apps are thin shells. Business logic lives in packages or server
domains, not route handlers. Use package public exports.

**Ports and adapters.** Domain logic depends on explicit ports, never concrete
adapters. Provider choice is configuration-driven DI at the composition root. Use
`domain/`, `ports/`, and `adapters/` where the seam earns it; new and growing
domains converge on that layout. Keep provider-specific types out of core logic.

**Tooling.** Use `pnpm`, Biome, and Nx. Do not use npm. Do not add raw colors outside
`packages/design-tokens`. Domain runtime lives under `apps/server/server/*`, not as
new top-level packages.

**Comments.** A file header says what the file is for and the key decisions in it.
Beyond that, comment **what the code can't say for itself**:

- **What a value represents** — units, what an id refers to, what a collection is
  keyed by and why, what "partial" / sentinel / null states mean.
- **Provider, protocol, and library quirks** — behavior you confirmed from a spec or
  SDK that a reader would otherwise have to go dig up.
- **Non-obvious mechanics** — ordering and sequencing constraints, buffering, why
  two things are reconciled, edge/error/abort paths, and the *why* behind a decision
  that looks odd at a glance.

Never narrate the obvious (`// increment i`). The test: would a competent reader
have to stop and reverse-engineer what this means or why it is here? **Comment the
weird; skip the self-evident.**

**Writing.** Load and apply `/llm-writing` before writing or revising user-facing text
or documentation: UI copy, guides, README files, AGENTS.md, `.context/`, KB pages,
work artifacts, PR descriptions, release notes. Apply `/information-hierarchy` to
multi-section documents: lead with what the reader needs, then disclose depth.

**Debugging.** Start from runtime evidence, not a guess. `pnpm obs` reads the local
EventSink (JSONL/Postgres, depending on `EVENT_PROVIDER`) and answers whether
`apps/server` actually saw a request/run/tool/gateway/checkpoint/WS event:

- `pnpm obs query --source server.route --limit 20` — did the API server see the HTTP request/status?
- `pnpm obs query --source runtime.gateway --limit 20` — provider routing/fallback/model-call diagnostics.
- `pnpm obs query --source runtime.checkpoint --limit 20` — checkpoint lifecycle/recovery diagnostics.
- `pnpm obs query --source lib.ws-thread-handler --limit 20` — thread WebSocket subscribe/resume/checkpoint diagnostics.

Interpretation rule: if a browser/API failure does **not** appear in `server.route`,
suspect the app dev proxy, portless/Tailscale route, browser URL, or another
pre-server layer before changing server domain code. If it does appear, use the
recorded source/name/status/correlation fields to narrow the server-side path.

## Knowledge and structure

**Read `.context/` first.** When working in a module, start from colocated knowledge,
not raw source files:

1. `meridian qi graph <path>` — shows `AGENTS.md` and `.context/CONTEXT.md`
2. Read `.context/CONTEXT.md` for contracts, architecture, invariants
3. Then read raw source to confirm specifics

Reading raw files without `.context/` framing produces worse results: you miss what
matters and over-report what is obvious. Root knowledge:

→ [.context/CONTEXT.md](.context/CONTEXT.md) — module dependency graph, harness
composition, DI wiring pattern, support packages, app layer, TypeScript↔Python
boundary, documentation tier model, module `.context/` index
→ [.context/architecture.md](.context/architecture.md) — full end-to-end
architecture: system topology, modular monolith layout, frontend data flow, API
server, visual design system, deferred features

**Root documentation is pointer-first.** Repo-root markdown stays thin; the
three-tier model is in the [`.context/` convention][kb-context-convention]. Do not
redefine canonical runtime terms in repo-root docs, and do not duplicate KB content
in `.context/CONTEXT.md` — link to the KB page instead.

- KB index: [kb-index]
- Runtime vocab: [kb-vocab]
- Runtime overview: [kb-runtime-overview]
- Decision records: [kb-decisions]

Update the relevant `AGENTS.md`, `.context/`, or KB material when a change shifts the
mental model, contracts, or decisions.

**Keep principles apart from implementation.** Write something as a decision or
principle only when it is meant to hold. Describe everything else as the current
implementation, which can change when a better design turns up. The owner's remarks
are direction and suggestions unless they say otherwise: quote them, keep their
uncertainty, and don't record them as rulings. Measurements and incident history go
beside the code or tool they concern, not into rules.

## Architecture

The host runs entirely in TypeScript (pnpm + Nx). Python is vendored in `python/`
for two non-host purposes:

| Subtree | Manager | Purpose |
|---|---|---|
| `packages/`, `apps/`, `tools/` (TypeScript) | pnpm + Nx | The whole host runtime, apps, and dev tooling |
| `python/` (`voluma-sdk`, `packages/*`) | uv | In-sandbox SDK and example agent packages; host executes via Daytona SDK (no in-repo FastAPI server) |

No Python runs on the host. The TypeScript ↔ Python boundary is a network boundary
(Daytona HTTPS + SSE), not a workspace or codegen boundary.

Honesty test: every `packages/*` workspace must fit one of these categories.

| Package | Role |
|---|---|
| `@voluma/contracts` | JSON-natural shared types (`threads`, `workbenches`, `works`, `protocol`, `runtime`, `preferences`, `interrupt`, `spawn`, `components`) |
| `@voluma/database` | Drizzle schema + connection for thread/workbench persistence |
| `@voluma/design-tokens` | Warm Organic CSS variables |
| `@voluma/prosemirror-schema` | Shared ProseMirror structural contract (node/mark specs + `buildDocumentSchema()`). Imported by both the server schema adapter and the frontend TipTap editor, which must construct **structurally identical** schemas or y-prosemirror corrupts the CRDT. Specs only — markdown syntax lives in adapters. A shared primitive, not domain runtime. |

Contract types must be JSON-natural — they survive `JSON.parse(JSON.stringify(x))`
unchanged. String IDs, string dates, union literal enums. No `Date`, `BigInt`, or
branded types. The `@voluma/contracts/runtime` subpath is IDs/config/usage DTOs only;
server-local behavioral ports live in the owning domain (for example
`domains/sandbox/ports/`).

Domain runtime is a modular monolith in `apps/server/server/`:

| Directory | Role |
|---|---|
| `domains/workbenches/` | Workbenches, works, user provisioning, ownership helpers |
| `domains/threads/` | Threads, turns, blocks, repositories, event journal, thread event hub |
| `domains/context/` | ContextPort router/factories, context document stores, uploads, input ingest, promotion/result documents |
| `domains/runtime/` | Orchestrator loop, model gateway, tool registry/executor, spawn/child runs |
| `domains/packages/` | Mars package install records, agent/skill catalog, default package seeding |
| `domains/collab/` | Yjs document sync and markdown projection spine |
| `domains/storage/` | Blob primitive: object put/get-signed-url/delete, keys, retention. Owns bytes only — no figure or profile-image semantics. |
| `domains/billing/` | Credit ledger and pricing conversion for model usage |
| `domains/observability/` | EventSink port and local/in-memory/noop adapters |
| `domains/preferences/` | Workbench preference repository port/adapters |
| `domains/sandbox/` | Sandbox lifecycle/command/filesystem/preview ports and adapters |
| `lib/` | Composition root (`app.ts`/`compose.ts`), routes-adjacent helpers, WS handlers |

`apps/app` and `apps/web` are thin shells — UI and marketing. Thread API/WS live in
`apps/server`.

## Dev environment

Dev does **not** use raw ports. Apps are served by **portless** at HTTPS `*.localhost`
URLs. Do not assume `localhost:3000`, bind ports by hand, or probe
`ws://127.0.0.1:<port>` — that bypasses the real proxy/TLS path.

- **Live URLs:** `pnpm portless:list` in the checkout that ran `pnpm dev`. Do not use
  `portless get` — it can disagree with named-mode routes (tailscale/funnel).
- **Modes:** `pnpm dev` prints `mode: local|tailscale|funnel`; tailscale is the
  default. Use `pnpm dev:local` or `--no-tailscale` for bare local portless. In
  **tailscale** / **funnel**, `portless:list` shows worktree-prefixed `*.localhost`
  URLs (via `portless run --name`) plus per-app `ts.net` URLs. Never use
  `portless app.voluma …` (collides).
- **Run the stack:** `pnpm dev` (worktree-scoped tmux). Reuse requires
  ownership/health/mode/route checks. Stop with `pnpm dev --stop`; stuck or stale
  stacks with `pnpm dev --restart` or `pnpm dev:restart`.
- **TLS for curl/node:** `NODE_EXTRA_CA_CERTS=~/.portless/ca.pem`
- After installing, upgrading, or patching a package, run `pnpm dev:restart`: the dev
  server does not watch `node_modules`.
- Postgres is worktree-scoped. `pnpm dev:db:ensure` prepares this worktree's database;
  migrations come from committed files via `drizzle-kit migrate`, never `push`. Use
  noninteractive libpq authentication (`PGPASSWORD` or `-w`).

A stack belongs to the session that started it: stop only yours, or reap idle ones
when asked. Setup and troubleshooting: [DEVELOPMENT.md](DEVELOPMENT.md). Dev tooling
rules: [tools/dev/AGENTS.md](tools/dev/AGENTS.md).

## Build and test

`pnpm check` is the full local gate: Biome lint → `check:package-shape` →
`typecheck` (Nx) → Vitest unit tests → `check:graph` → Python (`uv sync`, ruff, mypy,
pytest). Run it before you claim a change works.

CI (`.github/workflows/ci.yml`) runs the same in four jobs: `quality` (`pnpm lint`,
`pnpm typecheck`, `pnpm check:graph`), `test-ts` (Vitest with Postgres + MinIO),
`test-python` (ruff, mypy, pytest), and `e2e-main` (Playwright on `main` push only,
advisory). `pnpm test:db` runs the DB suite locally; `pnpm test:e2e` runs Playwright.
Drizzle migration chains and generated SQL are linted by `pnpm db:migration-lint`
(pre-commit runs the staged variant).

**Write few unit tests.** A new test must protect a named risk that no KB decision and
no probe already covers. A test that only restates a recorded decision, or a step a
manual probe already drives, covers no code: delete it in the change that supersedes
that decision, and prune a weaker duplicate rather than add another layer. To verify a
change, prefer probes, end-to-end smoke runs, and the written recipes in
[docs/testing/manual-probe-guides.md](docs/testing/manual-probe-guides.md); add or
update the recipe that covers what you changed.

Assert what a decision produces (state, rows, events, text), not mocks, call counts,
or internal shapes, unless the internal detail is itself the decision. A test file
that pins an implementation decision lists it in its header under
`Pins implementation decisions (rewrite or delete these cases when one changes):`.
When you change such a decision, find its tests with `git grep` and rewrite or delete
them in the same change.

## Git workflow

Commit continuously as you develop. Frequent commits create a verifiable history
trail where each step is independently reviewable and revertible. After each
self-contained change that passes checks, commit it — do not accumulate uncommitted
work or wait for approval to commit. Prefer small, logically scoped commits.

Add changelog entries to `CHANGELOG.md` under `## [Unreleased]`: one line per change,
linking the PR or commit for what changed and the work item for why.

A human merges product changes into `main` unless explicitly instructing the agent to
merge. Merges between working branches need no gate. Documentation-only changes
(`AGENTS.md`, `.context/`, KB, repo docs) commit directly to `main`; never open a PR
only for documentation.

Write the PR body for a reader who knows nothing about the area. Explain each term in
a few words the first time it appears, and link the issues, PRs, decisions, and code it
refers to. The [PR template](.github/PULL_REQUEST_TEMPLATE.md) holds the sections:
Why, Goal, Summary, Resulting Behavior, Work Item, Verification, Knowledge Updates,
Spawn Trace.

**Clean up as soon as you are done with something.** Idle dev stacks, databases, and
checkouts waste memory, CPU, and disk. When a worktree, dev stack, probe, review
checkout, or temporary branch has done its job — a worktree as soon as its branch
merges — clean it up, even while a human's shell or browser is still in it:

1. Stop its dev stack with `pnpm dev --stop` (this also prunes its portless routes).
2. End anything still running from it (watchers, `agent-browser` sessions, dev servers).
3. Remove the worktree and its merged branch (`git worktree remove`, `git branch -d`).
4. Drop its database with `pnpm dev:db:drop`.
5. Remove merged PR screenshot assets you added, then commit.

Before you hand control back, check that nothing you started is still running.

## Worktree discipline

**Never switch the branch of a checkout you don't own** — it may be shared. From the
primary checkout, create another branch under the sibling worktree root, then pass its
path to spawns with `--task-dir`:

```bash
git worktree add ../voluma-plat.worktrees/<name> -b <branch> <base>
```

## Links

- Use full GitHub URLs for the [Voluma docs repository][voluma-docs].
- Use relative links within this repository.
- Prefer reference-style links.

[voluma-docs]: https://github.com/voluma-bio/docs
[kb-index]: https://github.com/voluma-bio/docs/blob/main/kb/index.md
[kb-vocab]: https://github.com/voluma-bio/docs/blob/main/kb/wiki/runtime/vocab.md
[kb-runtime-overview]: https://github.com/voluma-bio/docs/blob/main/kb/wiki/runtime/overview.md
[kb-decisions]: https://github.com/voluma-bio/docs/blob/main/kb/decisions/README.md
[kb-context-convention]: https://github.com/voluma-bio/docs/blob/main/kb/wiki/dev/context-files.md
