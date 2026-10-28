# Runner: how sandboxes end

Sandboxes cost money while up (a GPU one a lot), so every one must end. In order of
who ends it:

1. **The runner, normally.** `main.ts` closes the sandbox in a `finally` when the thread
   ends, then flushes events (the flush runs even if the close throws).
2. **A signal.** SIGINT, SIGTERM and SIGHUP abort the running command; the `finally`
   above then closes the sandbox. A second signal terminates the sandbox directly, waits
   at most 5 s, and exits 130.
3. **A resume.** `create` terminates live sandboxes tagged with the same `{run, name}`.
4. **Modal's backstops.** 300 s with no command running (`idleSeconds`), and a hard
   lifetime of 3600 s (`VOLUMA_SANDBOX_LIFETIME_SECONDS` in `.env` overrides). A command's
   `timeoutSeconds` is clamped to the lifetime.
5. **A crash.** `kill -9` or a lost machine runs none of the above; the sandbox lives
   until the idle timeout (a command that is still running keeps it busy, so up to the
   lifetime). End it sooner with `pnpm --filter @voluma/runner sandboxes:clean`
   (`--dry-run` only lists): it terminates every live sandbox in the `voluma-runs`
   Modal app and prints each one's run, name and age. Age comes from the `startedAt`
   tag the adapter sets.

Run `sandboxes:clean` before finishing any work that started sandboxes.
