<!-- Write for the other lane's owner, who hasn't seen this work. Explain a
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
     requirements.md or the issue). -->

## What changed

<!-- The shape of the code after this PR: which module owns what now, what
     is new, what was deleted. A reader who hasn't opened the diff should be
     able to sketch it. Name any decision with a real alternative, and what
     it ruled out. -->

- **<structural change>.** <who owns what now>

## Knowledge layers, docs and deletions

<!-- What the other lane's agents read differently after this PR:
     AGENTS.md, .context/ (CONTEXT.md, TODO.md, decisions.md), DESIGN.md,
     README and other docs, each with one line on what changed. Then what
     this PR deleted: files, code paths, dependencies, config. "None." and
     why, if nothing changed. -->

- **Docs:** <file>: <what changed>
- **Deleted:** <what, and what replaced it>

## Contract changes

<!-- Changes to packages/contracts: the schema or command, what the other
     lane must change. Contract changes
     ship in their own small PR. "None." when contracts are untouched. -->

## Verification

<!-- What you ran and what you saw. For anything a user sees: a browser
     run with screenshots next to the matching mockup screen, against
     real OA6-1RK data. UI files changed but nothing
     looks different: write "No visual change" and why. Name any test added
     and the bug it guards against. -->

- Ran:
- Saw:

## Left out

<!-- Scope this PR doesn't cover and what comes right after it merges,
     each linked to an issue or noted in .context/. "None." if nothing. -->

- [ ] <item>: <where it's tracked>
