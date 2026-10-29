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
3. **A resume.** `create` terminates live sandboxes tagged with the same `{run, name}`. A creation is aborted with the run's signal (checked before that sweep, between terminations and before `create`), so a released run's creation cannot end the sandbox of the runner that reclaimed it. A process frozen past its lease (a sleeping laptop) can still act late.
4. **Modal ends it.** After 300 s with no command running (`VOLUMA_SANDBOX_IDLE_SECONDS` in
   `.env`, at least 30) or at a hard lifetime of 14400 s (`VOLUMA_SANDBOX_LIFETIME_SECONDS`).
   Before each call the session asks Modal whether a sandbox it handed out earlier still
   runs (`exitCode()`, 30-40 ms; null while it runs) and replaces a dead one (`stopped` with the exit code in its detail, then `starting`, `ready`
   events; Modal's SDK reports 124 for a timeout, 137 for any terminated sandbox (a terminate call or possibly an out-of-memory kill) and else the entrypoint's code). Modal also refuses commands for at least 15 s while it shuts a sandbox down,
   with `exitCode()` still null; the adapter turns that refusal (`FAILED_PRECONDITION`, "shutting
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

# Runner: `segment_sam` runs on the host

The tool (`packages/harness/src/tools/segment-sam.ts`) runs in the runner process, never in
the sandbox: the sandbox has no network and Meta's key must not enter it. It reads the
volume and writes the labels straight to the run's bucket (`Files` port, `r2-files.ts`;
`RunLayout.keyOf` maps the sandbox path the model names to its key), so a file the
sandbox just wrote is visible to it and the labels are visible to the sandbox after the call.
The Meta adapter (`meta-segmenter.ts`) shells out to `ffmpeg` for the lossless H.264 stack, so
the runner host needs it on PATH; it deletes its upload from Meta's file store when the call
ends (a failed delete is logged). Its response masks (`!` one_bit and `~` lossless) decode in `sam-mask.ts`, a port of
Meta's decoder, because `meta-sam-parser` takes minutes per response. The tool is offered only
when a Meta key exists (`VOLUMA_META_API_KEY`, or the visitor's key on a visitor run). What a
call costs goes to the run's usage meter and to the call's own `bill`, which the harness records as the `tool.result`'s `costUsd` so `spend` can charge the task (the adapter reports it as soon as Meta gives the frame count, so a failed call is still billed). The tool also writes a sidecar `<labels>.json` (prompt frames and per-slice confidence per object). The runner checks `ffmpeg -version` at start when a Meta key is set. How agents should use it (orientation, boxes,
which structures share a call) is the `sam-segmentation` skill's job, not the tool's.

# Runner: `view_image` shows the model files the sandbox wrote

`packages/harness/src/tools/view-image.ts` reads up to 4 PNG or JPEG files (1 MiB and 2000 px a side each, type
checked by magic bytes) from the run's bucket and returns them as image content; a `ToolResult`
may carry `images`, which the Pi adapter turns into image blocks. The `tool.result` event holds
only text (path, type, size, sha256). The images are in the thread's history (resume needs
them), but `adapters/pi/elide-images.ts` keeps image blocks only for the last 2 `view_image`
calls in each request, so request size does not grow with the thread.

**Model calls retry.** `run.ts` passes `maxRetries: 3` to Pi, which retries a 408, 429 (waiting
the server's `retry-after`), 5xx or dropped connection. `model-retry.ts` wraps every role's calls
(the main thread too) and keeps retrying those errors, and Meta's `404 model_not_found` that Pi
treats as final (about half of all calls on 2026-10-28), when the call failed before streaming
any content: backoff from 1 s doubling to a 30 s cap, until 4 minutes have passed since the first
attempt (Pi's own tries count against it; an attempt in flight is not cut short), each retry
logged with its role and attempt and reported to the fallback breaker. The run's abort ends the
wait. Any other error, or the spent budget, ends the call. A main-thread wake is also bounded
by the supervisor's `wakeTimeoutMs`. Anthropic errors carry no status in their text, so they
are not retried. `provider-error.ts` holds the error classification.
Cost is Pi's per-reply price, summed per claim; the log prints it
when a claim reports (`model cost this claim`), and the API stores it as `runs.model_cost_usd`.
On 2026-10-28 the claims' lines summed to the run's `model_cost_usd` and to `spend(events).total`
($0.9763 over five claims of one run).

# Runner: what `/outputs` and `/scratch` support

Both are R2 bucket mounts (`modal-sandbox.ts`), so a file is written whole, once. Rename
(`sed -i`, editors), append, in-place edits and memory-mapped writes
(`np.lib.format.open_memmap(mode="w+")`) fail there: the model builds a file under `/tmp`
(local disk, lost on a sandbox restart) and `cp`s it in. The worker and check prompts
(`prompts.ts`) and the bash tool description (`layout.ts`) say so.

**`/scratch` stays an R2 mount**, though it is only intermediate files. Three things read it
from the host, not from the sandbox: `segment_sam` reads its volume and writes its labels
there (`RunLayout.keyOf`), a long bash output is stored there for the model to open
(`toolOutputPath`), and a checkpoint's evidence may be a `scratch` file, which the host copies
into the run's evidence (`r2-evidence.ts`). The restart note also promises it survives a restart.
A local `/scratch` would break all three.

# Runner: who gets which task tools

A worker has `checklist`, `checkpoint` and `report_output`; a check thread only `checkpoint`
(`supervise-run.ts`). A check re-derives values to compare and gives them in its checkpoint's
text with its verdict (the review shows the checker's verdict and text); it never replaces the
worker's outputs, so the runtime refuses its `report_output` and never opens a `fix` revision.
`fix` stays in the event schema and `fold` for now (removing it is a contract change).
`checkpoint`'s arguments go through `prepareCheckpoint` before validation, so the habits of
models (a top-level `title`, `toCheck` as a string or with `text`, a nested `{root, path}`)
don't cost a turn.

# Runner: sandbox memory

One sandbox serves the whole run (name `main`), so tasks that run in parallel share its memory
and 2 CPUs. A sandbox has 8192 MiB (`run.ts`). `classic_segment` measured 2.8-3.1 GB anonymous memory and
about 4.0-4.25 GB RSS with the memory-mapped scan, so 4096 MiB risked an OOM kill in a
full run.
Two concurrent heavy steps fit: their anonymous memory adds up (about 6 GB) and the mapped scan
file is shared page cache, not counted twice. The `stopped` event of a sandbox Modal ended carries its exit code (Modal's SDK: 124 a timeout, 137 any terminated
sandbox, so an out-of-memory kill or a terminate call), so a restart's cause is in the run's record. In the 2026-10-28 local run the sandbox ended at 1 h 0 min (the
lifetime) and once more 23 min into the replacement, before the exit code was logged.
