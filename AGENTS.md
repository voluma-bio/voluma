# Voluma Platform — Agent Instructions

> **Greenfield.** This repo has no application code yet. There are no real users and no
> production data. Build the smallest thing that proves the current idea, delete what
> you don't need, and never add a compatibility shim. Once migrations exist, write them
> as if production data does: no data loss, online-safe DDL, and no steps that rely on
> empty tables.

## Nothing is built yet

No app, test suite, dev stack, or observability tooling lives here. Do not cite files
or run commands that are not in this repo.

The current implementation and its conventions are in the sibling checkout at
`../voluma-legacy` — start with its `AGENTS.md`, `DESIGN.md`, `DEVELOPMENT.md`, and
`.context/`. Port what this repo's design needs; do not copy the tree.

## Mission

**Scientists should spend their time on their research, not analysis software.**
Voluma takes everything between the raw data and the publication — and makes every
result provable. Every architectural and product decision should survive the
question: *does this help a researcher trust and publish their result?*

We want the code right so that change stays easy: this is an exploratory state, no
backwards compatibility is required, and carrying cost is a bug.

## Engineering principles

**Fix structural debt in the same change.** Do not defer parallel hierarchies, leaking
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

**Clean up as you go.** Stop what you started, and delete throwaway branches,
worktrees, and scratch files when they have done their job.

## Conventions

**Layering.** Apps are thin shells. Business logic lives in packages or service
domains, not route handlers. Use package public exports.

**Ports and adapters.** Domain logic depends on explicit ports, never concrete
adapters. Provider choice is configuration-driven DI at the composition root. Use
`domain/`, `ports/`, and `adapters/` where the seam earns it; new and growing domains
converge on that layout. Keep provider-specific types out of core logic.

**Tooling.** Use `pnpm`, Biome, and Nx. Do not use npm. Colors come from one
design-tokens package, never raw values scattered through components.

**Comments.** A file header says what the file is for and the key decisions in it.
Beyond that, comment **what the code can't say for itself**:

- **What a value represents** — units, what an id refers to, what a collection is keyed
  by and why, what "partial" / sentinel / null states mean.
- **Provider, protocol, and library quirks** — behavior you confirmed from a spec or SDK
  that a reader would otherwise have to go dig up.
- **Non-obvious mechanics** — ordering and sequencing constraints, buffering, why two
  things are reconciled, edge/error/abort paths, and the *why* behind a decision that
  looks odd at a glance.

Never narrate the obvious (`// increment i`). The test: would a competent reader have
to stop and reverse-engineer what this means or why it is here? **Comment the weird;
skip the self-evident.**

**Writing.** Load and apply `/llm-writing` before writing or revising user-facing text
or documentation: UI copy, guides, README files, AGENTS.md, `.context/`, KB pages, work
artifacts, PR descriptions, release notes. Apply `/information-hierarchy` to
multi-section documents: lead with what the reader needs, then disclose depth.

## Documentation

Root docs stay thin and pointer-first; the three-tier model is in the
[`.context/` convention][kb-context-convention]. Do not redefine canonical terms in
repo-root docs, and do not duplicate KB content in `.context/CONTEXT.md` — link to the
KB page.

- KB index: [kb-index]
- Runtime vocab: [kb-vocab]
- Runtime overview: [kb-runtime-overview]
- Decision records: [kb-decisions]

Update the relevant `AGENTS.md`, `.context/`, or KB material when a change shifts the
mental model, contracts, or decisions.

**Keep principles apart from implementation.** Write something as a decision or
principle only when it is meant to hold. Describe everything else as the current
implementation, which can change when a better design turns up. The owner's remarks are
direction and suggestions unless they say otherwise: quote them, keep their uncertainty,
and don't record them as rulings. Measurements and incident history go beside the code
or tool they concern, not into rules.

## Git workflow

Commit continuously as you develop. Frequent commits create a verifiable history trail
where each step is independently reviewable and revertible. After each self-contained
change that passes checks, commit it — do not accumulate uncommitted work or wait for
approval to commit. Prefer small, logically scoped commits.

A human merges product changes into `main` unless explicitly instructing the agent to
merge. Merges between working branches need no gate. Documentation-only changes commit
directly to `main`; never open a PR only for documentation.

**Never switch the branch of a checkout you don't own** — it may be shared. From the
primary checkout, create another branch under the sibling worktree root, then pass its
path to spawns with `--task-dir`:

```bash
git worktree add ../voluma.worktrees/<name> -b <branch> <base>
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
