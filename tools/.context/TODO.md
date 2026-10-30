# Worktree cleanup

- `worktrees-clean.mjs` is read-only. Before restoring deletion, settle with the
  owners which explicitly selected checkouts and local resources may be discarded.
  A merged or closed PR does not cover later local commits, untracked or ignored
  files, active sessions, or a branch reused for another PR. Define retention or
  backup for these resources; commit age is not checkout inactivity.
- Any destructive replacement must prove ownership rather than infer it from a
  process's working directory or a database name. `dev.mjs` supports different
  database servers, and independent clones share a server without sharing Git's
  worktree registry. Preserve unknown resources; do not infer orphan databases
  from the complement of one repository's worktree list.
- Before enabling deletion, verify primary/current/locked checkout protection,
  exact published commit and repository identity, ambiguous or failed GitHub reads,
  stale refs, concurrent edits/worktree creation, and process identity across exit
  and PID reuse. Exercise these only in disposable repositories and databases.
