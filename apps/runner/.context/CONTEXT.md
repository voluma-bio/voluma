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
   `.env`, at least 30) or at a hard lifetime of 14400 s (`VOLUMA_SANDBOX_LIFETIME_SECONDS`).
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
call costs goes to the run's usage meter (the adapter reports it as soon as Meta gives the frame count, so a failed call is still billed). The tool also writes a sidecar `<labels>.json` (prompt frames and per-slice confidence per object). The runner checks `ffmpeg -version` at start when a Meta key is set. How agents should use it (orientation, boxes,
which structures share a call) is the `sam-segmentation` skill's job, not the tool's.

# Runner: `view_image` shows the model files the sandbox wrote

`packages/harness/src/tools/view-image.ts` reads up to 4 PNG or JPEG files (1 MiB and 2000 px a side each, type
checked by magic bytes) from the run's bucket and returns them as image content; a `ToolResult`
may carry `images`, which the Pi adapter turns into image blocks. The `tool.result` event holds
only text (path, type, size, sha256). The images are in the thread's history (resume needs
them), but `adapters/pi/elide-images.ts` keeps image blocks only for the last 2 `view_image`
calls in each request, so request size does not grow with the thread.

**Model calls retry.** `run.ts` passes `maxRetries: 3` to Pi, which retries a 408, 429 (waiting
the server's `retry-after`), 5xx or dropped connection. `model-retry.ts` adds one case Pi treats as
final: Meta's intermittent `404 model_not_found` (only from the `meta` provider; about one tool call
in five on 2026-10-28 with a working key), retried up to 4 attempts in all, 1 s, 2 s, 4 s apart,
when the call failed before streaming any content. Any other error ends the thread as before.
Cost is Pi's per-reply price, summed per claim; the log prints it
when a claim reports (`model cost this claim`), and the API stores it as `runs.model_cost_usd`.

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
file is shared page cache, not counted twice. Whether a given restart was an out-of-memory kill
is not known: `alive()` only says the sandbox ended (the event reads "ended by the provider"), and
Modal's exit code is not logged. In the 2026-10-28 local run the sandbox ended at 1 h 0 min (the
lifetime) and once more 23 min into the replacement, with no reason recorded. See TODO.md.
