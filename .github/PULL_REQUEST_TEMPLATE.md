<!-- Write for the other person, who hasn't seen this work. Explain a
     term the first time it appears and link what you refer to. Open each
     section with its point; describe the final state, not the journey.

     Every ## section is required; the PR-body check fails without it. When
     one doesn't apply, write "None." and why. Agents: `gh pr create
     --body-file` skips GitHub's template, so copy these sections in. Check a
     draft locally with `pnpm check:pr-body <body.md>`. -->

## Changelog

<!-- One line per change someone will notice, starting Added:, Changed:,
     Fixed: or Removed:. Internal-only work says "None." and why. -->

- Added: <what someone can now do>

## Why

<!-- The problem, who it affects, and which requirement it serves (link
     requirements.md or the issue). Show the before state when it exists:
     the current screen, failing output, a timing. -->

## Design decisions

<!-- The decisions that shaped the change, each aimed at the underlying
     problem rather than its symptom: what was wrong, what this PR decides,
     and what it rules out. Quote the owner where a ruling set the decision.
     "None." when the change involves no choice. -->

1. **<decision>.** <the problem>. <what this PR decides>. Ruled out: <alternative and why>.

## Walkthrough

<!-- How a reviewer sees each change for themselves, one ### per change:
     setup (main or this branch, how to start it, which data), numbered
     steps, and what to expect on main and on this branch. A screen change
     shows screenshots beside its steps. A script, CLI or library change is
     copy-pasteable commands with their real output, trimmed to the lines
     that show the change. A change with no manual path gives the test
     command and the edit that makes it fail. Then, for a change that spans
     several files, the order to read them in and what each one does. -->

### <change>

1. Setup: ...
2. ...
3. Expect: main ... This branch ...

## What changed

<!-- The shape of the code after this PR: which module owns what now, what
     is new, what was deleted. A reader who hasn't opened the diff should be
     able to sketch it. -->

- **<structural change>.** <who owns what now>

## Risk and where to look

<!-- What breaks or changes for existing runs, data on disk and other
     callers, and how to undo it. Then the two or three files or behaviours
     where a reviewer's time pays off most, and why. -->

- Breaks or changes:
- Where to look:

## Knowledge layers, docs and deletions

<!-- What other agents read differently after this PR:
     AGENTS.md, .context/ (CONTEXT.md, TODO.md, decisions.md), DESIGN.md,
     README and other docs, each with one line on what changed. Then what
     this PR deleted: files, code paths, dependencies, config. "None." and
     why, if nothing changed. -->

- **Docs:** <file>: <what changed>
- **Deleted:** <what, and what replaced it>

## Contract changes

<!-- Changes to packages/contracts: the schema or command, and every caller
     this PR moved with it. A change that stands alone ships in its own
     small PR; a breaking one may ship with its callers. "None." when
     contracts are untouched. -->

## Verification

<!-- What you ran and what you saw, expected against observed. For anything
     a user sees: a browser run with screenshots next to the matching mockup
     screen, against real OA6-1RK data. UI files changed but nothing looks
     different: write "No visual change" and why. Name any test added and
     the bug it guards against. Steps belong in Walkthrough. -->

- Ran:
- Saw:

## Left out

<!-- Scope this PR doesn't cover and what comes right after it merges,
     each linked to an issue or noted in .context/. "None." if nothing. -->

- [ ] <item>: <where it's tracked>
