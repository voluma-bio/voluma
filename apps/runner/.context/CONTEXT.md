# Runner: how sandboxes end

Sandboxes cost money while up (a GPU one a lot), so every one must end. In order of
who ends it:

1. **The runner, normally.** `run.ts` closes the run's sandbox when the supervisor ends,
   before it flushes events and reports, so the `stopped` event and the last sandbox seconds
   are stored under the live lease. If the close takes over 60 s (15 s after a stop) it asks Modal to terminate
   the sandboxes of this claim, by their `{run, claim}` tags (the claim is a per-claim id: a
   released run's old runner must not kill the sandbox of the runner that reclaimed it).
2. **A signal.** SIGINT and SIGTERM stop every run (the running command is killed), each
   reports `released` first, so the run is recovered within the platform's grace period,
   then closes its sandbox (no `stopped` event is stored); the service waits up to 30 s. A second signal
   exits 130 at once and leaves the sandboxes (use `sandboxes:clean`). Signal the process
   group (Ctrl-C does); `kill <pid of pnpm>` alone leaves the runner running.
3. **A resume.** `create` terminates live sandboxes tagged with the same `{run, name}`.
4. **Modal ends it.** After 300 s with no command running (`VOLUMA_SANDBOX_IDLE_SECONDS` in
   `.env`, at least 30) or at a hard lifetime of 3600 s (`VOLUMA_SANDBOX_LIFETIME_SECONDS`).
   Before each call the session asks Modal whether a sandbox it handed out earlier still
   runs (`alive()`, 30-40 ms) and replaces a dead one (`stopped`, then `starting`, `ready`
   events). Modal also refuses commands for at least 15 s while it shuts a sandbox down,
   with `alive()` still true; the adapter turns that refusal (`FAILED_PRECONDITION`, "shutting
   down", at command start) into `SandboxEndedError`, and the session replaces the sandbox
   and runs the command again once. Either way the model gets the restart note, and files
   outside the mounts are gone. A sandbox that dies during a command still fails that
   command. Lifetime is per sandbox, so a replacement gets a fresh one: it does not limit
   the run. A command's `timeoutSeconds` is clamped to the lifetime.
5. **A crash.** `kill -9` or a lost machine runs none of the above; the sandbox lives
   until a running command ends (at most its timeout) plus the idle timeout. End it
   sooner with `pnpm --filter @voluma/runner sandboxes:clean` (`--dry-run` only lists): it
   terminates every live sandbox in the `voluma-runs` Modal app and prints each one's run,
   name and age (from the `startedAt` tag the adapter sets). `--run <id>` limits it to one
   run, which is what to use when other agents have runs going: the bare form ends theirs too.

Run `sandboxes:clean --run <your run>` before finishing any work that started sandboxes.
