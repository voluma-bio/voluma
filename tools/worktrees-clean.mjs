/**
 * `pnpm worktrees:clean`: read-only inventory of this repository's registered worktrees.
 * PR state, process cwd and database names do not establish ownership or permission to delete.
 * Destructive cleanup is disabled until its preservation policy is settled (tools/.context/TODO.md).
 */
import { execFileSync } from "node:child_process";

if (process.argv.length > 2) {
  console.error(
    "worktrees:clean is read-only; --yes and other arguments are not supported. Nothing was changed.",
  );
  process.exit(1);
}

console.log("Registered worktrees (not a deletion plan; nothing will be removed):");
execFileSync("git", ["--no-optional-locks", "worktree", "list"], {
  cwd: import.meta.dirname,
  stdio: "inherit",
});
console.log(
  "Automatic cleanup is disabled. Preserve local files and commits, and confirm ownership before removing resources manually.",
);
