# Runner: sandbox roles

A sandbox is created from a spec with a role (`packages/harness/src/sandbox-specs.ts`), which fixes
its size (2 CPUs, 8192 MiB), its network and which mounts it holds. Tags on every sandbox:
`{run, name, claim, startedAt}`; `sandboxes:clean --run` ends all roles.

| Role | Mounts | Network | Name |
|---|---|---|---|
| `worker` | as the caller says (today the worker `ThreadLayout.mounts`) | the gateway host over HTTPS (`outboundDomainAllowlist`), if the spec has a `gateway`; else none | `<taskId>.worker[.n]` |
| `checker` | `readOnly` mounts read-only, one writable `scratch` prefix | none | `<taskId>.check[.n]` |
| `convert` | `evidence` read-only, `review` writable | none | the job's |

The builder sets the access of each mount, and the Modal adapter refuses a network on a
non-worker role. The runner makes one sandbox per thread (`sandboxSession.get(threadId)`,
named by the thread id without the run id). `RunLayout.forThread(threadId)`
(`packages/harness/src/layout.ts`) gives each thread its role, mounts, tool description, restart note,
`keyOf` and bash-spill path, so a worker and a checker each see their own files:

- A worker mounts `/inputs` and `/workflow` read-only and `/scratch` (the run's whole scratch) and
  `/outputs` read-write, and works in `/scratch/<its name>/` like every role, so parallel workers
  don't overwrite each other's fixed-name files.
- A checker mounts `/inputs`, `/workflow` and `/outputs` read-only and one writable folder,
  `/scratch/<its name>/` (the name is the sandbox name, e.g. `t1.check`), which is the R2 prefix
  `scratch/<name>/` under the run. Its bash does not see the rest of `/scratch`. Host-side
  (`keyOf`, so `view_image`) it also reads, read-only, the files in the run's `/scratch` that the
  attempt under review cites (`{root: "scratch"}` refs on its checkpoints and outputs, and the
  `root: "scratch"` files in an output's own payload, `fileRefsOf`), and no others: the worker's
  scripts, logs and notes stay unread. Cited means the path, not the bytes. `keyOf` asks the
  `(path) => boolean` that `forThread(threadId, cited)` takes; callers pass
  `(p) => runtime.cites(taskId, p)`, answered from the fold (`FoldedTask.citedScratch`).
  The same `keyOf` check validates the evidence a checker names. The main agent
  (`<runId>.main[.n]`) has the same mounts and reads the run's whole `/scratch` host-side; it has
  no sandbox today.
- Every thread spills a truncated bash output to `/scratch/<name>/.tool-output/<id>`
  (`toolOutputKey(runId, threadName, toolCallId)`), a worker too.
- Every sandbox has env `SCRATCH` (`/scratch/<name>` for every role) and runs
  its commands there (`SandboxSpec.workdir`); the prompt tells the model to write working files
  under `$SCRATCH`.
- The path namespace is the same for every thread: `/scratch/<name>/x.png` is the key
  `scratchKey(runId, "<name>/x.png")`, so a checkpoint's evidence `{root: "scratch", path:
  "<name>/x.png"}` resolves the same way (`r2Evidence`, the local evidence adapter). Before
  `evidence.keep`, `taskRuntime` checks each evidence path with the calling thread's
  `keyOf(..., "read")`, so a thread cites only what it can read.
- The sandbox's own `/scratch` directory exists in the container. A write outside
  `/scratch/<name>/` (say `/scratch/v1.jpg`) succeeds but is local and lost on restart. Nothing
  stops it: sandboxes run as root without `CAP_SYS_ADMIN` (`chmod a-w` does not bind root, no
  `chattr`, no remount), and a mount over `/scratch` would be the worker's scratch. The fence is
  `$SCRATCH` as the working directory and in the prompt. A checker that writes `/scratch/v1.jpg`
  locally and cites `v1.jpg` is refused unless the worker cited `v1.jpg`, in which case the
  citation resolves to the worker's file.
- Thread ids are built and parsed in `packages/harness/src/thread-id.ts`.

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
- A checker sandbox with a read-write mount at `/scratch/<name>` (prefix `scratch/<name>/`) beside
  read-only `/outputs` (run p470): a write under `/scratch/<name>/` reached R2 at
  `runs/<run>/scratch/<name>/`; a write to `/outputs` failed with `Read-only file system`; DNS
  failed (no network); no gateway variable. `/scratch` itself is a container directory, not a mount.
- Same sandbox shape (run p483): commands run as uid 0 with `CapEff` lacking `CAP_SYS_ADMIN` and
  `CAP_LINUX_IMMUTABLE`; `SCRATCH` and the exec `workdir` (`/scratch/t1.check`) take effect;
  `touch /scratch/outside.txt` succeeds, also after `chmod a-w /scratch`; `chattr` is absent.

# Runner: how sandboxes end

Sandboxes cost money while up (a GPU one a lot), so every one must end. In order of
who ends it:

1. **The runner, normally.** `run.ts` closes the run's sandboxes (one per thread) when the run loop ends,
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

# Runner: `segment_sam` runs in the worker's sandbox

The tool (`packages/harness/src/tools/segment-sam.ts`) checks the paths and runs `voluma-sam`
(`packages/voluma-sam`, baked into the sandbox image with Node 24 and `ffmpeg`) in the calling
thread's sandbox, with the run's abort signal and a 30-minute timeout; the runner holds no
volume and does none of the work. The program reads the `.npy` by position (never whole), crops it (`subVolume`, else
the tissue plus a margin, always including the boxes), encodes lossless H.264, sends it to Meta
through the gateway (`$VOLUMA_GATEWAY_URL/meta/v1/...`, the sandbox's token as the bearer; the
sandbox's network is that host only; only a sandbox whose role is granted `segment_sam` gets the
network and the token, so a check sandbox stays `network: none` with no token), decodes the masks (`sam-mask.ts`, a port of Meta's
decoder, because `meta-sam-parser` takes minutes per response) and writes the labels on the
full grid and the sidecar `<labels>.json`: built in `/tmp`, then `cp`ed, because an R2 mount takes
whole files only. An old sidecar is deleted first and the new one, written last, carries the call's
`requestId` (the result repeats it): the labels are complete when the sidecar exists with that id.
The tool returns its one JSON line; a gateway or network failure comes back as an error result
with `infrastructure: true`. Nothing in the runner meters SAM: its spend is the gateway's
`provider_calls` rows. The tool is offered when `VOLUMA_GATEWAY_URL` is set. How agents should
use it (orientation, boxes, which structures share a call) is the `sam-segmentation` skill's job.

Why not in the runner: its one Node thread receiving and decoding Meta's 100+ MB reply starved
the heartbeat and the run stopped itself (design `infrastructure.md` §6 and `evidence/findings.md` in voluma-bio/docs).
Why TypeScript: the decoder takes seconds there and minutes in Python.

# Runner: `dev-sandbox` drives the real sandbox, tools and gateway without a model

`pnpm --filter @voluma/runner dev-sandbox --run <id> [--role worker]` (`src/dev-sandbox.ts`) claims the next
queued run and gives it back unless it is `<id>` (start one in the web app, or insert one in the
local database); it refuses an API that is not on this machine unless `--allow-remote` is given, holds its lease with
the real heartbeat, opens the role's sandbox through the real adapter and reads commands from
stdin: `exec <command>`, `segment <json>` (the real `segment_sam` tool) and `close` (ends the
run `failed` with "closed by dev-sandbox", terminates the claim's sandboxes by tag). It needs the
runner's `.env` plus `VOLUMA_GATEWAY_URL`. After each command it prints this process's event-loop
delay and the heartbeat count and slowest round trip: that is how to check that a call leaves the
runner's thread alone. Sandbox seconds are metered like a run's, the gateway counts the provider
calls against the run's cap. Run `sandboxes:clean --run <id>` after, as for any sandbox.

To try `voluma-sam` without a live Meta call, point `VOLUMA_GATEWAY_URL` at a stub gateway in front
of a stub Meta that replays a saved response. Modal must reach it over HTTPS (its host is the
worker's allowlist), so host it in a Modal sandbox on an encrypted tunnel. The reference scan's
input is DICOM: put the `.npy` under the run's `scratch/` prefix first.

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
wait. Any other error, or the spent budget, ends the call. `provider-error.ts` holds the one error classification (retry, redo and breaker):
it reads the status in the text (Pi's `<provider> API error (<status>)`, or the Anthropic SDK's
`<status> {...}`, `<status> <html>` or `<status> status code (no body)`) and, for an Anthropic error sent mid-stream
with no status, its documented `error.type` (`overloaded_error` is 529, `rate_limit_error` 429).

**A thread that dies on a provider error** (`provider-error.ts`, after the retries above gave up)
is the run loop's to handle (`packages/harness/src/run-loop.ts`): a check is started again as a new
check, the main agent as `main.<n+1>`, up to `maxProviderRedos` (2) per thread; a worker's failure
is a notice to the main agent. A fatal error (a refused key, with no fallback model) fails the run
at once, with the error in `state.error`, instead of leaving it `completed` with tasks that never
started.

**Loop limits** are `config.loop`: `RUNNER_MAX_FIX_ROUNDS` (default 2 `needs-review` rounds per
task before it is left to check) and `RUNNER_CHECK_TIMEOUT_MINUTES` (default 20 of a checker's
active time). The harness defaults the rest (`LoopConfig`).

Cost is Pi's per-reply price, summed per claim; the log prints it
when a claim reports (`model cost this claim`), and the API stores it as `runs.model_cost_usd`.
On 2026-10-28 the claims' lines summed to the run's `model_cost_usd` and to `spend(events).total`
($0.9763 over five claims of one run).

**Spend cap.** `RUNNER_MAX_RUN_COST_USD` caps a run's dollars across all its claims (sandbox time
is not counted). Unset, the default, there is no cap: test runs have none, so leave it unset on
staging and locally (spend is still recorded and shown). When set it goes to the API with each
claim and becomes `runs.cost_cap_usd` (null: no cap),
which the provider gateway checks too ([apps/gateway](../../gateway/.context/CONTEXT.md)). The runner's
total is the last heartbeat's `spentUsd` (model cost plus settled gateway calls; an open call
counts nothing, the gateway holds its reservation itself) plus the model cost not yet sent, checked on each model cost and each acknowledged
heartbeat; at the cap `run.ts` stops the run and reports `ended failed` with
`spend cap $X reached at $Y`. Calls in flight are aborted, not waited for. A claim of a run already over the cap stops before its first call. It applies to visitor runs too. The run loop ends the root thread `cancelled` in the event log while the run row says `failed` with the cap text.

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

A worker has `checkpoint`, `report_output` and `submit_task`; a check thread `checkpoint` and
`ask` (its role file's `tools`). A check re-derives values to compare and gives them in its checkpoint's
text with its verdict (the review shows the checker's verdict and text); it never replaces the
worker's outputs, so the runtime refuses its `report_output`. Only a redo of a task with attempted dependents opens another revision.
`checkpoint`'s arguments go through `prepareCheckpoint` before validation, so the habits of
models (a top-level `title`, `toCheck` as a string or with `text`, a nested `{root, path}`)
don't cost a turn.

# Runner: sandbox memory

Each thread has its own sandbox (`sandboxSession`), destroyed when the run loop sees the thread end (`release`; a resumed thread gets a fresh one and the restart note), so only the heavy steps of one thread share
its memory and 2 CPUs. Every role's sandbox has 8192 MiB (`sandbox-specs.ts`). `classic_segment` measured 2.8-3.1 GB anonymous memory and
about 4.0-4.25 GB RSS with the memory-mapped scan, so 4096 MiB risked an OOM kill in a
full run.
Two heavy steps of one thread running at once fit: their anonymous memory adds up (about 6 GB) and the mapped scan
file is shared page cache, not counted twice. The `stopped` event of a sandbox Modal ended carries its exit code (Modal's SDK: 124 a timeout, 137 any terminated
sandbox, so an out-of-memory kill or a terminate call), so a restart's cause is in the run's record. In the 2026-10-28 local run the sandbox ended at 1 h 0 min (the
lifetime) and once more 23 min into the replacement, before the exit code was logged.

# Runner: role text, tool grants and models come from `workflows/core/agents/`

The worker's, checker's and (when its file grants `bash`) main's system prompts are `workflows/core/agents/<role>.md`'s body, then `COMMON`
(sandbox text per role, `prompts.ts` `systemPrompt`), then the role's skill list and the tool index (one line per skill
script, from its docstring's first line; the loader reads it from the snapshot). Their optional tools are the file's `tools`
(`run.ts` `grant`); `segment_sam` is also dropped when the run has no Meta key, and always for the checker (it calls out to Meta; `keepFailed` writes the run-wide scratch). `loadWorkflow`
snapshots the role files with the workflow and reads them from the snapshot, so a resumed thread
composes byte-identical text and an edited file reaches only new threads (a thread whose prompt
changed is still `ThreadStale`). The main agent without `bash` gets its file's body alone. `review-chat.md` is
`status: planned` and unused. Format: `workflows/core/agents/AGENTS.md`.

A role's model is its file's `model` alias. `config.models` maps each alias to a provider model:
`RUNNER_MODEL_WONDER` (default `meta/muse-wonder-1.0`), `RUNNER_MODEL_OPUS`, `RUNNER_MODEL_ASTRA`
(no default; a run whose role file names an unset alias fails when it starts). `RUNNER_MODEL`, when
set, forces every alias to one model. Each configured alias's provider key is required at start. A
visitor run uses `RUNNER_VISITOR_MODEL` for every role except `main` on a visitor-safe model.

# Runner: a claim that ends is a cut-off, not a stop

A stop the runtime chooses (shutdown, a heartbeat that wasn't acknowledged for 45 s, a lost
lease, the server ending the run) aborts the run's signal. Threads see it as `runSignal`
(`start-thread.ts`): from that moment they store nothing more and write no `thread.ended`,
exactly as after a crash, and the run loop writes none for the root, even if a step threw
while the signal was aborting. So a `thread.ended {cancelled}` is a stop someone chose and is
never resumed: a stale dependent's thread stopped (`task-runtime.ts` `staleDependents`), or a
failing run aborting its threads (`abortAll`). A stop stores that `cancelled` end first
(`task-runtime.ts` `stop`, inside `section`) and then aborts without waiting; the thread's own
later end is dropped (`start-thread.ts`). So a stopped thread's next write is refused at once,
and "open" always means "cut off". A self-stop reports `released` with reason `self-stop`; a signal, `shutdown`.

The next claim learns why from `claim.previousClaim` (the API records `lease-expired` itself)
and writes `claim.started {resumed, after}` right after the root's `thread.started`. The
run loop then resumes each thread still in charge, if its latest `thread.started` has no
`thread.ended` and this process hasn't started it: the worker only when it holds its task, the
check only when the task is `under-review` and it is the current check, the latest main. It
resumes with the message of `cutOffText`, naming the tool the log shows with no result, or the
no-tool form, and a tool the cut-off interrupted is answered from the log (`tools/effects.ts`).
A cut-off resume counts as no delivery and no redo. A thread that ended `cancelled` is never
resumed. A tool whose `tool.call` event was
still queued when the runner died isn't named (the log lacks it), so a runner killed within
milliseconds of a call gets the no-tool form.

The API bounds restarts with one limit (`apps/api/.context/deploy.md`); the runner has no
restart counter of its own.

# Runner: telemetry, and what an uncaught error does

`telemetry.ts` starts after startup (a failure before it still kills the process). Every line starts
with `telemetry`; on Railway search the deploy logs for these:

| grep | Line | Means |
|---|---|---|
| `telemetry loop-delay` | once a minute: `p99=…ms max=…ms` | event-loop delay over the last minute; p99 includes the 10 ms sampling interval (an idle loop reads about 11 ms). A healthy runner stays well under 1 s; the heartbeat deadline is `LEASE_SECONDS - HEARTBEAT_SECONDS` |
| `telemetry heartbeat-rtt` | once a minute: `p50`, `max`, `n` | send-to-answer time of the acknowledged heartbeats (absent when none were acknowledged) |
| `telemetry loop-block` | when a 100 ms timer fires over 1 s late: `…ms; in flight: <run> <thread> <tool>; …` | the loop was held that long, and the tool calls recorded as started and not yet resulted at that moment (`no tool`: none) |
| `[<run>] telemetry unhandledRejection in this run` / `uncaughtException in this run` | on the error | an error nobody caught, tied to its run and logged through its redacting log: that run stops (`stop: error`) and ends `failed` with the error's message; other runs go on. After the run's report is fixed the line says `after its report was fixed` and nothing changes |
| `telemetry … outside any run` | on the error | tied to no run; logged and the process stays up |
| `stop: <reason>` | per run, once per reason | every stop reason (the console is the only record of the later ones), with the first (the one that decides the report) named when it differs |
| `release not stored` / `end not stored` | after a `report` | the server answered 409: the run ended first or the lease is gone |

An error is tied to its run by `AsyncLocalStorage` (`runScope`), set around each `runClaim`: the
async context an error was raised in survives into the process handler, so it names the run
without parsing messages. An error raised from a timer or callback created inside a run's work
belongs to that run; one raised by the main loop's own code (claiming) belongs to none.
