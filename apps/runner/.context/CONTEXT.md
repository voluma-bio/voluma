# Runner: how sandboxes end

Sandboxes cost money while up (a GPU one a lot), so every one must end. In order of
who ends it:

1. **The runner, normally.** `main.ts` closes the sandbox in a `finally` when the thread
   ends, then flushes events (the flush runs even if the close throws).
2. **A signal.** SIGINT, SIGTERM and SIGHUP abort the running command; the `finally`
   above then closes the sandbox (Modal's terminate takes ~20-30 s to finish while a
   command was running). A second signal also terminates the run's sandboxes by their
   `{run}` tag (closing waits for a sandbox still being created, which can take minutes
   while inputs stage), waits at most 5 s, and exits 130. Signal the process group (Ctrl-C
   does); `kill <pid of pnpm>` alone leaves the runner running.
3. **A resume.** `create` terminates live sandboxes tagged with the same `{run, name}`.
4. **Modal ends it.** After 300 s with no command running (`VOLUMA_SANDBOX_IDLE_SECONDS` in
   `.env`, at least 30) or at a hard lifetime of 3600 s (`VOLUMA_SANDBOX_LIFETIME_SECONDS`).
   The session replaces the sandbox on the next call (`stopped`, then `starting`, `ready`
   events) and the model gets the restart note; files outside the mounts are gone. A sandbox
   that dies during a command still fails that command. Lifetime is per sandbox, so a
   replacement gets a fresh one: it does not limit the run. A command's `timeoutSeconds` is
   clamped to the lifetime.
5. **A crash.** `kill -9` or a lost machine runs none of the above; the sandbox lives
   until a running command ends (at most its timeout) plus the idle timeout. End it
   sooner with `pnpm --filter @voluma/runner sandboxes:clean` (`--dry-run` only lists): it
   terminates every live sandbox in the `voluma-runs` Modal app and prints each one's run,
   name and age (from the `startedAt` tag the adapter sets). `--run <id>` limits it to one
   run, which is what to use when other agents have runs going: the bare form ends theirs too.

Run `sandboxes:clean --run <your run>` before finishing any work that started sandboxes.
