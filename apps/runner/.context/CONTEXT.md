# Runner: sandbox roles

A sandbox is created from a spec with a role (`packages/harness/src/sandbox-specs.ts`), which fixes
its size (2 CPUs, 8192 MiB), its network and which mounts it holds. Tags on every sandbox:
`{run, name, claim, startedAt}`; `sandboxes:clean --run` ends all roles.

| Role | Mounts | Network | Name |
|---|---|---|---|
| `worker` | as the caller says (today `RunLayout.mounts`) | the gateway host over HTTPS (`outboundDomainAllowlist`), if the spec has a `gateway`; else none | `<taskId>.worker[.n]` |
| `checker` | `readOnly` mounts read-only, one writable `scratch` prefix | none | `<taskId>.check[.n]` |
| `convert` | `evidence` read-only, `review` writable | none | the job's |

The builder sets the access of each mount, and the Modal adapter refuses a network on a
non-worker role. The runner makes one sandbox per thread (`sandboxSession.get(threadId)`,
named by the thread id without the run id). **Check threads still run on a worker-role
sandbox**: the checker spec exists, but the run-wide `/scratch` is assumed by the check skills
(`/scratch/recheck/`), by checkpoint evidence `{root: "scratch", path}` (`r2Evidence`), by the
`bash` spill (`toolOutputPath`) and by `view_image`/`segment_sam` (`RunLayout.keyOf`). Moving them
to `/scratch/<check thread>/` needs those four to take the thread, and the skill text to change.
The checker's other writes: none (`workflows/core/agents/checker.md` says it changes nothing).
Spend and the usage meter sum sandbox seconds over all sandboxes.

**Probed 2026-10-29 (Modal SDK 0.11.1, run p414), the facts the design relied on:**

- R2 mount writes work with `outboundDomainAllowlist` set and with `blockNetwork: true`: read,
  write and `ls` all succeeded on a read-write mount in both. A read-only mount refuses writes
  (`Read-only file system`).
- A mount does not cache listings for long: sandbox B had listed `/shared` (one file), sandbox A
  then wrote `late.txt`, and B's next `ls` and `cat` (an exec round trip, about 0.6 s later) saw
  it; a sandbox created afterwards listed it too. So a checker sees a file a worker just wrote.
- With an allowlist, HTTPS to the listed host works, and another host (`www.google.com`, by name),
  an IP (`1.1.1.1`) and plain HTTP (even to the listed host) fail. **DNS queries still leave**:
  `www.google.com` resolved to an address, and a name that does not exist got NXDOMAIN, while a
  `blockNetwork` sandbox cannot resolve anything. The allowlist therefore needs `https://` gateway
  URLs, and the worker sandbox can encode data in lookups of names it picks: treat the token and
  mounts as readable by anything the worker's code does.
- The sandbox's `/proc/meminfo` shows the host, not the 8 GiB request; the limit is not
  observable from inside.

# Runner: how sandboxes end

Sandboxes cost money while up (a GPU one a lot), so every one must end. In order of
who ends it:

1. **The runner, normally.** `run.ts` closes the run's sandboxes (one per thread) when the supervisor ends,
   before it flushes events and reports, so the `stopped` event and the last sandbox seconds
   are stored under the live lease. If the close takes over 60 s (15 s after a stop) it asks Modal to terminate
   the sandboxes of this claim, by their `{run, claim}` tags (the claim is a per-claim id: a
   released run's old runner must not kill the sandbox of the runner that reclaimed it).
2. **A signal.** SIGINT and SIGTERM stop every run (the running command is killed), each
   reports `released` with reason `shutdown` first, so the run is recovered within the platform's grace period,
   then closes its sandbox (no `stopped` event is stored); the service waits up to 30 s. A second signal
   exits 130 at once and leaves the sandboxes (use `sandboxes:clean`). Signal the process
   group (Ctrl-C does); `kill <pid of pnpm>` alone leaves the runner running.
3. **A resume.** Right after a claim succeeds, `run.ts` terminates every live sandbox tagged with the run but not this claim (`terminateOtherClaims`: one list call, then each sandbox's tags; no wait). The claim holds the lease, so nothing an earlier claim started keeps writing or spending. The sweep is cleanup and never decides the run's outcome: an error is logged and retried once, and the idle timeout backs it up. A creation is aborted with the run's signal, so a released run's creation cannot start a sandbox beside the runner that reclaimed it. A process frozen past its lease (a sleeping laptop) can still act late.
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
by the supervisor's `wakeTimeoutMs`. `provider-error.ts` holds the one error classification (retry, redo and breaker):
it reads the status in the text (Pi's `<provider> API error (<status>)`, or the Anthropic SDK's
`<status> {...}`, `<status> <html>` or `<status> status code (no body)`) and, for an Anthropic error sent mid-stream
with no status, its documented `error.type` (`overloaded_error` is 529, `rate_limit_error` 429).

**A worker or check that dies on a provider error** (`provider-error.ts`, after the retries above
gave up) is started again by the supervisor with no main-thread call, since the main thread uses
the same provider: a worker's task on a fresh thread (a code-made `redo` judgment, arm
`code:provider-error`), a check as a new check. Twice per task and role; the third failure fails
the run, with the error in `state.error`, instead of leaving it `completed` with tasks that never
started. A main-thread call that fails is recorded as that call's error in the `wake` and in the
judgment's reason.

Cost is Pi's per-reply price, summed per claim; the log prints it
when a claim reports (`model cost this claim`), and the API stores it as `runs.model_cost_usd`.
On 2026-10-28 the claims' lines summed to the run's `model_cost_usd` and to `spend(events).total`
($0.9763 over five claims of one run).

**Spend cap.** `RUNNER_MAX_RUN_COST_USD` (default 5) caps a run's model and SAM dollars across all
its claims (the claim's `run.usage` plus this claim's meter; sandbox time is not counted). The meter
calls back on each addition; at the cap `run.ts` stops the run and reports `ended failed` with
`spend cap $X reached at $Y`. Calls in flight are aborted, not waited for. A claim of a run already over the cap stops before its first call. It applies to visitor runs too. The supervisor ends the root thread `cancelled` in the event log while the run row says `failed` with the cap text.

**A main-thread reply that does not parse.** `llmMainThread` escapes raw control characters inside
JSON strings, and otherwise sends the reply back once with what was wrong (appended after the
cached prefix); if that fails too, the wake records both errors and the cost of both calls, and the judgment falls back as for
any failed main thread.

**`segment_sam` 404.** Meta answers `404 model_not_found` for some inputs (seen: a small box prompt)
and bills nothing for it. The adapter retries once on the uploaded file; a second 404 throws a
message with Meta's body and every object asked for (name, box), saying the cause is this input or an outage and how to tell. It
does not bisect: each successful probe costs a full SAM call ($0.07-0.10).

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
worker's outputs, so the runtime refuses its `report_output`. Only a worker redo after a
supervisor correction opens another revision.
`checkpoint`'s arguments go through `prepareCheckpoint` before validation, so the habits of
models (a top-level `title`, `toCheck` as a string or with `text`, a nested `{root, path}`)
don't cost a turn.

# Runner: sandbox memory

Each thread has its own sandbox (`sandboxSession`), destroyed when the supervisor sees the thread end (`release`; a resumed thread gets a fresh one and the restart note), so only the heavy steps of one thread share
its memory and 2 CPUs. Every role's sandbox has 8192 MiB (`sandbox-specs.ts`). `classic_segment` measured 2.8-3.1 GB anonymous memory and
about 4.0-4.25 GB RSS with the memory-mapped scan, so 4096 MiB risked an OOM kill in a
full run.
Two heavy steps of one thread running at once fit: their anonymous memory adds up (about 6 GB) and the mapped scan
file is shared page cache, not counted twice. The `stopped` event of a sandbox Modal ended carries its exit code (Modal's SDK: 124 a timeout, 137 any terminated
sandbox, so an out-of-memory kill or a terminate call), so a restart's cause is in the run's record. In the 2026-10-28 local run the sandbox ended at 1 h 0 min (the
lifetime) and once more 23 min into the replacement, before the exit code was logged.

# Runner: role text and tool grants come from `workflows/core/agents/`

The worker's and checker's system prompts are `workflows/core/agents/<role>.md`'s body, then `COMMON`
(sandbox text, `prompts.ts`), then the skill list. Their optional tools are the file's `tools`
(`run.ts` `grant`); `segment_sam` is also dropped when the run has no Meta key. `loadWorkflow`
snapshots the role files with the workflow and reads them from the snapshot, so a resumed thread
composes byte-identical text and an edited file reaches only new threads (a thread whose prompt
changed is still `ThreadStale`). The main thread still uses `MAIN_SYSTEM`; `lead.md` and
`review-chat.md` are `status: planned` and unused. Format: `workflows/core/agents/AGENTS.md`. Models stay
config (`RUNNER_MODEL`, `RUNNER_CHECK_MODEL`, `RUNNER_MAIN_MODEL`).

# Runner: a claim that ends is a cut-off, not a stop

A stop the runtime chooses (shutdown, a heartbeat that wasn't acknowledged for 45 s, a lost
lease, the server ending the run) aborts the run's signal. Threads see it as `runSignal`
(`start-thread.ts`): from that moment they store nothing more and write no `thread.ended`,
exactly as after a crash, and the supervisor writes none for the root, even if a step threw
while the signal was aborting. So a `thread.ended {cancelled}` is a stop someone chose and is
never resumed: a stale dependent's thread stopped (`task-runtime.ts` `staleDependents`), or a
failing run aborting its threads (`abortAll`). A stop aimed at a thread this process has not
started (cut off by an earlier claim) writes that `cancelled` end itself (`supervise-run.ts`
`stopThread`), so "open" always means "cut off". A self-stop reports `released` with reason `self-stop`; a signal, `shutdown`.

The next claim learns why from `claim.previousClaim` (the API records `lease-expired` itself)
and writes `claim.started {resumed, after}` right after the root's `thread.started`. The
supervisor then resumes the thread in charge of each task, if its latest `thread.started` has
no `thread.ended` and this process hasn't started it: the worker only when it is the task's
current worker (or the task has no attempt yet), the check only when the task is
`under-review` and it is the current check. It resumes with the message of
`supervisor.ts` `cutOffText`, naming the tool the log shows with no result, or the no-tool
form. A cut-off resume is not a wake, so it spends none of the stuck guard's two and counts
no redo; the main thread isn't asked. The "You stopped, but ... is not finished" wake is for a
thread that ended `completed` with its task unfinished. A worker that ended `cancelled` with
its task `in-progress` gets a fresh worker; a check that ended `cancelled` gets a new check. A tool whose `tool.call` event was
still queued when the runner died isn't named (the log lacks it), so a runner killed within
milliseconds of a call gets the no-tool form.

The API bounds restarts with one limit (`apps/api/.context/deploy.md`); the runner has no
restart counter of its own.
