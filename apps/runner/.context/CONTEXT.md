# Runner: sandbox roles

A sandbox is created from a spec with a role (`packages/harness/src/sandbox-specs.ts`), which fixes
its size (2 CPUs, 8192 MiB), its network and which mounts it holds. Tags on every sandbox:
`{run, name, claim, startedAt}`; `sandboxes:clean --run` ends all roles.

| Role | Mounts | Network | Name |
|---|---|---|---|
| `worker` | as the caller says (today the worker `ThreadLayout.mounts`) | gateway IPv4 `/32` when configured, otherwise TLS SNI allowlist; no gateway: none | `<taskId>.worker[.n]` |
| `check` | `readOnly` mounts read-only, one writable `scratch` prefix | none | `<taskId>.check[.n]` |
| `convert` | `evidence` read-only, `review` writable | none | the job's |

`VOLUMA_GATEWAY_IPV4` selects a single-address CIDR policy instead of SNI, never both (Modal
unions them). It must be an exclusive inbound IPv4, not a resolved shared Render/Cloudflare IP.
Staging leaves it unset: the Host-header escape is still open. CIDR permits all ports/protocols
to that address and still permits DNS; it does not make scans exfiltration-proof. Deployment
choices, approval gates and probes: [gateway deploy](../../gateway/.context/deploy.md#dedicated-ip-cutover-236-awaiting-approval).

The builder sets the access of each mount, and the Modal adapter refuses a network on a
non-worker role. The runner makes one sandbox per thread (`sandboxSession.get(threadId)`,
named by the thread's `name`, its id without the run id). `RunLayout.forThread(record)` (a `ThreadRecord`, or the identity of a thread about to start)
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
  `(path) => boolean` that `forThread(thread, cited)` takes; callers pass
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
  "<name>/x.png"}` resolves the same way (`storeEvidence`). Before
  `evidence.keep`, `taskRuntime` checks each evidence path with the calling thread's
  `keyOf(..., "read")`, so a thread cites only what it can read.
- **Evidence is hashed in the sandbox, not the runner.** The runner holds and moves no
  scan-sized data (a run reports a ~943 MB scan and ~224 MB grid). For a path the calling
  thread's sandbox mounts, `taskRuntime` runs `sha256sum` there (`bash`-style, through
  `sandboxSession.get(id, { note: false })`, so the hash exec never consumes the restart note
  owed to the model; the file goes in on stdin) and passes the hash to `keep` as a callback; `storeEvidence` HEADs the
  source, calls it only on an ETag it has not seen for that key in this claim, then HEADs the
  target and does the server-side `CopyObject`. It never GETs the body, except for a path the
  caller's sandbox does not mount (a checker citing the worker's scratch), which it hashes by
  streaming up to 64 MiB and refuses above that. The copy carries `CopySourceIfMatch: etag`, so
  a file rewritten after the hash fails the call. A missing file is a `Refusal`. Content addressing, not tamper-proofing: the agent writes the bytes
  anyway. Measured on 940 MB: host network in 1 GB per keep before, 8 MB on the first keep and
  0.1 MB on a repeat after.
- The sandbox's own `/scratch` directory exists in the container. A write outside
  `/scratch/<name>/` (say `/scratch/v1.jpg`) succeeds but is local and lost on restart. Nothing
  stops it: sandboxes run as root without `CAP_SYS_ADMIN` (`chmod a-w` does not bind root, no
  `chattr`, no remount), and a mount over `/scratch` would be the worker's scratch. The fence is
  `$SCRATCH` as the working directory and in the prompt. A checker that writes `/scratch/v1.jpg`
  locally and cites `v1.jpg` is refused unless the worker cited `v1.jpg`, in which case the
  citation resolves to the worker's file.
- Readers take a thread's `name`, `role` and `taskId` from its `ThreadRecord`, never from its id.
  `threadName` (`packages/contracts/src/threads.ts`) is the one parser of an id; ids are minted only
  in `run-loop.ts` (`nextThread`) and `supervise-run.ts` (`rootThreadIdOf`). The runner knows a
  thread's layout, and so its name, by id from `run.ts`'s `laidOut` map (filled by the run loop).

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
- **What an R2 mount accepts (run p659, a worker sandbox, `/scratch` vs local disk).** A file created
  or replaced by writing it whole in one pass works (`open(...,'wb')`, `np.save`, PIL, matplotlib,
  json, `cp`/`shutil.copy` from `/tmp`, a 200 MB sequential write, `>` over an existing file). These
  fail: seeking back (`EINVAL`: `np.savez`, `tifffile`, `f.seek` while writing), reopening to update
  (`r+`, `w+`: `EBADF`; `open_memmap(mode='w+')` also leaves a 128-byte stub), append (`>>`, `'a'`:
  `EPERM`), `truncate`, `rename`/`os.replace`/`mv`/`sed -i` within the mount (`ENOSYS`), `cp -p`/`-a`
  and `shutil.copy2`/`move` from `/tmp` (the copy lands, then setting times is `EPERM`; `mv` also
  removes the source). VTK savers (pyvista `.save`) with the output on the mount crash Python
  (`.vtp`: segfault or `double free`) or fail (`.stl`); `.vtk` and `.ply` happen to work. The working
  directory on the mount is harmless by itself: reading from it and saving to `/tmp` works. A
  written key was visible to a host `HEAD` within ~100 ms of the writer closing the file (fsync
  changed nothing). Modal's SDK 0.11.1 offers no cache or write-mode option on `CloudBucketMount`
  (read-only, requester-pays, endpoint, prefix, OIDC role only), so the rule is told to the model
  in `ThreadLayout.description` and any script writes locally and copies.

# Runner: review assets

`packages/harness/src/review-assets.ts` converts every file a task reports as a volume, a
structure mask or a surface (`convertJob`) into review assets while the run is live, and
records `assets.ready` / `assets.failed` on the root thread (id `<runId>:assets:<sha256>`).
`run.ts` starts it at claim beside `superviseRun`.

- **Queue.** Every `output` event in the recorder's view, from the first (so a resume reads the
  whole log), minus files with an `assets.*` event; new events are polled once a second.
  One file at a time, in one `convert` sandbox per claim (created at the first file, metered
  like the others). A failed conversion is recorded and the worker moves on; a sandbox that
  dies or cannot be created is replaced once, then the file is recorded failed. `sourceSha256`
  is the queue item's; a converter that prints another one has failed.
- **Mounts.** `/evidence` (the run's evidence prefix) and `/workflow` read-only, `/review`
  (`reviewAssetPrefix`) read-write, no network. The snapshot keeps repo paths and includes
  `core/convert/`, so the command is `python /workflow/workflows/core/convert/review_assets.py` (not `-I`, which drops the `PYTHONPATH`
  the converter imports `sidecar` through; the sandbox gets `RunLayout.pythonPath` alone).
  A cloud-bucket mount cannot rename, which zarr's local store does for every file: the converter
  builds in a fixed `/tmp` path it clears at the start, and copies, `manifest.json` last. A
  non-zero exit from a sandbox that is gone counts as a sandbox failure (the one retry), not a
  failed file.
- **Signal.** One rule: the worker halts exactly when the stop will not end the run (server stop,
  lost lease, self-stop, shutdown; `reportFor` is not `ended`). An uncaught
  `error` ends the run, so the worker drains, as it does on `finally`'s own `abort`, which the worker outlives.
  `run.ts` remembers which stop halted it (`haltedBy`) and rebuilds the report from that one,
  never from the first stop. A stopped worker records nothing; the next claim finds the files again and the
  converter skips what has a `manifest.json` of its version and mode.
- **Drain.** An `ended` report waits for the queue (`DRAIN_MS`, 10 minutes, the lease
  heartbeating meanwhile), before the sandboxes close. Then every output still without an
  `assets.*` event is recorded `assets.failed` ("timed out", or "the run ended before the file
  was converted" for an output stored late), so an ended run leaves no file "preparing". Events go
  through `emit` (retried) and count as done once stored. This is **permanent for the run**: the next claim
  skips it and review shows the object without assets. A stop during the drain ends it at once and the run is reported `released` (nothing, for a server stop or a lost lease) instead of `ended`, so the next claim resumes the queue.
  A `released` report does not drain.
- **Not built.** Conversions run one at a time in one 2-CPU sandbox; the scan (about 1 GB of
  float32) is the long pole. Add sandboxes if the drain times out in practice.

# Runner: how sandboxes end

Sandboxes cost money while up (a GPU one a lot), so every one must end. In order of
who ends it:

1. **The runner, normally.** `run.ts` closes the run's sandboxes (one per thread) when the run loop ends,
   draining the convert queue meanwhile (a close takes ~30 s) and then closing the convert sandbox, before it flushes events and reports, so the `stopped` event and the last sandbox seconds
   are stored under the live lease. If the close takes over 60 s (15 s after a stop) it asks Modal to terminate
   the sandboxes of this claim, by their `{run, claim}` tags (the claim is a per-claim id: a
   released run's old runner must not kill the sandbox of the runner that reclaimed it).
2. **A signal.** SIGINT and SIGTERM stop every run (the running command is killed), each
   reports `released` with reason `shutdown` first, so the run is recovered within the platform's grace period,
   then closes its sandbox (no `stopped` event is stored); the service waits up to 50 s (Render's grace is 60 s), and the release retries for what is left of it after a 15 s cap on the final flush, so a deploy that overlaps an API outage is still recorded as `shutdown`. A second signal
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

**Starting one can fail.** The R2 credential mint (`mintCredentials`) retries 429, 5xx, network errors
and Cloudflare's spurious `403` code `10042` ("enable R2", seen once, gone 41 s later) up to 5 tries
with 1, 2, 4 and 8 s between them; any other 4xx (a bad token) fails at once. When creation still
fails, the Pi adapter returns the tool call as an error result with `infrastructure: true`
(`SandboxUnavailableError`), so the model and the run page see Voluma's failure, not the agent's;
the session forgets the failed creation, and the model's next call tries again.

# Runner: `segment_sam` runs in the worker's sandbox

The tool (`packages/harness/src/tools/segment-sam.ts`) checks the paths and runs `voluma-sam`
(`packages/voluma-sam`, baked into the sandbox image with Node 24 and `ffmpeg`) in the calling
thread's sandbox, with the run's abort signal and a 30-minute timeout; the runner holds no
volume and does none of the work. The program reads the `.npy` by position (never whole), crops it (`subVolume`, else
the tissue plus a margin, always including the boxes), encodes lossless H.264, sends it to Meta
through the gateway (`$VOLUMA_GATEWAY_URL/meta/v1/...`, the sandbox's token as the bearer; the
sandbox's network uses the gateway's SNI or dedicated IPv4; only a sandbox whose role is granted `segment_sam` gets the
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

# Runner: the local test loop (edit a skill, run, read the result)

An agent in its own worktree tries a workflow change on the real system like this:

1. `pnpm db:up` once, then `pnpm dev`. That runs without SAM. **Every SAM call is paid and needs Jimmy's
   yes first** (say how many calls and why); with it, `pnpm dev --sam` and `VOLUMA_META_API_KEY` in `.env` also start the gateway
   (this worktree's database, a per-launch secret) and a Cloudflare quick tunnel to it, and writes the
   tunnel's URL and the secret to `.dev/env.json`, where a local runner reads them. Wait for the
   `gateway https://…trycloudflare.com` line before starting the runner.
2. `RUNNER_MODEL=deepseek/deepseek-flash pnpm --filter @voluma/runner start` (set in `.env` or the shell:
   one cheap model for every role; `RUNNER_THINKING` as usual). Test runs may use any model; production and
   demo runs (staging) use Meta models only. Meta SAM is the only Meta call here, about $0.10 each.
3. `pnpm --filter @voluma/runner try-run [--scan <inputId>] [--workflow <id>] [--outputs a,b] [--notes …]`
   (`src/try-run.ts`) signs in as `WORKOS_TEST_EMAIL`, starts a study and run on the reference scan,
   follows the run's event stream until it ends and prints per-task status, outputs reported and missing,
   cost and the run page. Exit 1 when the run failed or was cancelled, 2 when the script itself broke
   (no `pnpm dev`, sign-in or API errors), 3 when no runner claimed the run in 3 minutes. Edits to `workflows/` are read from
   the checkout when a run starts, so edit, then try-run again.
4. `sandboxes:clean --run <id>` for each run, as always.

When the runner uses the API in `.dev/env.json` (including an explicit `VOLUMA_API_URL` pointing
there), that file alone supplies its gateway. Matching uses the origin (the HTTP adapters ignore
the base URL's path, query and fragment) and treats `localhost` as the launcher's `127.0.0.1`;
different ports or schemes remain different APIs. `VOLUMA_GATEWAY_URL`, `VOLUMA_GATEWAY_IPV4` and `GATEWAY_TOKEN_SECRET` in the
shell or `.env` cannot turn SAM on or override the launcher's tunnel. No gateway URL in the file
means SAM is off, including while the tunnel starts or after it fails. A runner pointed at another
API still uses its configured gateway pair. Restart the runner when changing the dev launch;
an already-running runner does not reload `.dev/env.json`.
The launcher atomically replaces the manifest with a mode-0600 file, and the runner selects its
API and gateway from one snapshot, so a rewrite cannot mix launches or expose a partial file.

Why a tunnel: sandboxes run on Modal and reach only an https host from an allowlist, never `localhost`.
A Cloudflare quick tunnel (`cloudflared` npm package runs it; `pnpm dev` downloads the pinned official release once into
`~/.cache/voluma/cloudflared-<version>` and checks its sha256, kept in `tools/dev.mjs`) needs no account, no system install, works on Linux and macOS (also ARM), and gives
each `pnpm dev` its own random URL, so worktrees share nothing. The URL is public, so the gateway's token
check is the only door: a request with no or a bad token is 401. Costs: a download on first use, a new URL
per launch (restart the runner after `pnpm dev` restarts; the runner reads the gateway once, and its
boot line says `gateway <url>` or `gateway off`), and quick tunnels are best effort (Cloudflare
gives no uptime promise). Tried and not chosen: Tailscale Funnel (ties it to one person's tailnet; fixed
hostname and shared ports), Modal's own tunnel (exposes a port of a sandbox, it cannot reach back to this
machine), localtunnel (no binary, but flaky and gates browsers behind a page).
Without the tunnel (no `--sam`, no Meta key, download or hash check failed, no network) `pnpm dev` says so and writes no gateway URL:
runs work, sandboxes have no network and `segment_sam` is not offered.

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

To run the real runner against a stub model provider (a fake that returns 503s or canned replies),
set every `VOLUMA_<PROVIDER>_API_KEY` in that runner's environment to a dummy value, not a real key. A
model call the stub misses then fails closed with a 401 instead of reaching the provider. A resumed
thread takes its model from the log, so a base-URL override set for one model can miss it.

# Runner: `view_image` shows the model files the sandbox wrote

`packages/harness/src/tools/view-image.ts` reads up to 4 PNG or JPEG files from the run's bucket (a path outside
the mounts, such as the sandbox's `/tmp`, through the thread's sandbox: `tools/read-whole.ts`) and returns them as
image content; a `ToolResult` may carry `images`, which the Pi adapter turns into image blocks. An image over
1 MiB or 2000 px a side is downscaled with sharp (EXIF orientation applied, fit to 2000 px, JPEG, quality lowered until under 1 MiB) and the
result line says from what size. The `tool.result` event holds only text (path, type, size, sha256).

**Stored history keeps images by reference.** `adapters/pi/image-refs.ts` wraps the History port
(`supervise-run.ts`): a message is stored with each image block replaced by `{type: "imageRef", key, sha256, mimeType}`,
and the bytes the model saw (so the downscaled ones) are written to `historyImageKey` in the thread's scratch
(`scratch/<thread name>/.images/<sha256>`, content-addressed). A resumed thread loads the images of the messages since its
latest compaction back from R2 (the only ones a request carries); earlier ones load as the "no longer shown" note, reads stop after the image's 1 MiB limit (its scratch object can be overwritten by a sandbox), and an object that is gone or whose sha256 differs loads as a short "not available" note.
Rows stored before this hold inline image blocks and load unchanged. The runner's resume is the only reader that
parses history; `export:run`, `import:run` and the example seed copy rows as text, so a dump moved to another bucket
keeps references that resolve only in the bucket that holds the objects (they load as the note elsewhere).
The example seed retains the source run's image keys, not copies under the example. History rows are trusted:
the loader reads the key in each reference, even when it names another run. A database export or archive alone
is therefore not an independent image backup. Retaining those objects, remapping them for portable copies,
and rolling back to a runner that cannot decode `imageRef` need an operator policy before cleanup or rollback;
there is no automatic conversion to inline rows.

**Context compaction.** `adapters/pi/compaction.ts`; nothing rewrites history between requests, so the provider's
cache prefix stays intact. Before each request the thread's input is estimated (last reply's input, cache and output
tokens plus the chars/4 of what came after) and so are its images: bytes and count against the model's
`inputLimits` (`maxRequestBytes`, `images.maxPerRequest`; 32 MiB and 100 when a model declares none). Trigger:
input over min(400k, 0.9 x (`contextWindow` - reserve)), reserve = min(64k, model `maxTokens`, window/4); 350k when
the window is unknown; or images over 40% of a limit. Past it, a runtime user message tells the thread to finish the
step and write down what it needs, it gets 3 more turns, then its own model summarizes it on a warm branch (same
messages, system message and tools, summary instruction appended). Skipped notice, compaction at once: another turn
would not fit (input + reserve > window, or images over 70% of a limit). Cold summary (`[system, previous summary,
messages to summarize]`, no kept tail, images left out): when the warm request plus the 16k summary would not fit
(or images over 90%), and always when the provider refused a request as too large (`recover`, called from
`start-thread.ts`; then one retry in the same thread, started by a note stored only after the summary was; a failed
recovery leaves the refusal as the thread's failure (unless the summary's own error is transient: then it ends the thread as that error and the run retries it), and a second refusal ends it as before). A summary that stops on
length is retried once with twice the room (the thread's reasoning setting stays, so the cache holds; both calls' usage is recorded); one that also called a tool is accepted by its text.
A compaction that would leave the thread due again (the last turn alone is over a limit) waits until a request is tight or cold. A failed summary fails the thread with the provider's own error text (so `provider-error.ts` classifies it), the
context in a log line. The summary reply is recorded as an assistant `message` event with its usage, so spend counts
it, a failed summary's usage too (an event with `compaction: true` and no text). The event carries `compaction: true`: the run page shows it as a collapsed "History summarized" row (the notices read "Context notice") and leaves it out of a thread's `said` and `reply`. The wrap-up and overflow notices are steered in with sender `{kind: "runtime", notice: true}`, which `thread-log` does not count as a nudge. One overflow test (`context-overflow.ts`: a 400, a 413 or no
status, and Pi's patterns) serves both this and the runner's classifier.
The result is a marker row `{role: "compaction", summary, keptFrom}` appended to `pi_messages`; every earlier row
stays. `keptFrom` indexes the thread's messages (rows that are not markers); `foldHistory` rebuilds them and the
latest marker (and derives where it sat), and a request carries `[system, summary message, messages from keptFrom]`
(the last ~20% of each limit `load` checks: the trigger in tokens, the byte limit and the image-count limit, so a compaction always leaves the thread not due; starting at a user or assistant message, so a
call keeps its results). The system prompt is untouched (resume compares it). Each compaction logs `compaction:
thread …` with tokens before and after. Images stay in history until a compaction; the loader fetches only those from
`keptFrom`.

**Tools resolve paths the same way.** `ThreadLayout.resolve` reads a relative path from the thread's `dir`
(`$SCRATCH`); `keyOf` resolves first. A missing file is refused as "No file at <path>" plus the files in its folder
that this thread can read (`Files.list`, `FileNotFound`), never the store's own error or a checker's uncited sibling
files. Sandbox reads bound the bytes read, not the size reported by `stat` (files can grow; `/proc` reports zero).
Evidence may be given as a plain path (`/outputs/<task>/x`, `/scratch/<thread>/x`). An outputs `{root, path}` ref
is always relative to `/outputs/<task>/`: `keep` never strips another task-id segment, which could name a real subfolder.

**Provider errors fail fast.** `run.ts` passes `maxRetries: 3` to Pi, which retries a 408, 429
(waiting the server's `retry-after`), 5xx or dropped connection. `model-retry.ts` wraps every
role's calls (the main thread too) and keeps retrying those errors (`isTransientProviderError`)
when the call failed before streaming any content: backoff from 1 s doubling to a 30 s cap, until
60 s have passed since the first attempt (Pi's own tries count against it; an attempt in flight is
not cut short), each retry logged with its role and attempt. The run's abort ends the wait. Any
other error, a 4xx included (Meta's `404 model_not_found` too), or the spent budget, ends the call
at once. The failed reply is stored and the thread ends `failed` with the provider's message. The
run loop (`packages/harness/src/run-loop.ts`) sees a thread this process ran that failed on a
provider error (`providerFailure` in `provider-error.ts`: any 4xx or 5xx status, a connection
failure, an empty account) and fails the run with it in `state.error`: "the main agent failed on a
model provider error: <message>", or "<taskId>: its worker failed on a model provider error:
<message>". A retryable error (the set above) on a thread that already streamed content, or that
outlasted the 60 s, resumes that thread once ("The model provider failed during your last reply;
continue.") before the run fails; the resumed call has its own 60 s. A context overflow (400/413
"prompt is too long", `context_length_exceeded`, `request_too_large`; Pi's `isContextOverflow`)
is not a provider error (only with status 400/413 or none; a 5xx body never counts): it fails that thread only. A failed main is never resumed: `main()` starts a fresh `main.<n>` with the restart brief, once per failed main, and a fresh main that fails too fails the run with its error. A failed worker keeps its history; main replaces it with `stop_worker` then `start_worker`. Nothing
releases the run to wait or redoes the thread. `provider-error.ts` holds the classification: it
reads the status in the text (Pi's `<provider> API error (<status>)`, or the Anthropic SDK's
`<status> {...}`, `<status> <html>` or `<status> status code (no body)`) and, for an Anthropic error sent mid-stream
with no status, its documented `error.type` (`overloaded_error` is 529, `rate_limit_error` 429).
A run held "AI unavailable" under the earlier release rule is claimed again at the next claim
(see `apps/api/.context/deploy.md`).

**Loop limits** are `config.loop`: `RUNNER_MAX_FIX_ROUNDS` (default 2 `needs-review` rounds per
task before it is left to check). The harness defaults the rest (`LoopConfig`). No limit is
on time: a checker ends with its verdict or when it is stopped (a stale mark, feedback, the run's
end).

Cost is Pi's per-reply price, summed per claim; the log prints it
when a claim reports (`model cost this claim`), and the API stores it as `runs.model_cost_usd`.
On 2026-10-28 the claims' lines summed to the run's `model_cost_usd` and to `spend(events).total`
($0.9763 over five claims of one run).

**No spend cap.** Spend is recorded and shown, never limited: no run, claim or gateway call is refused or stopped for cost (removed 2026-10-30; [decisions](../../../.context/decisions.md)).

**`segment_sam` 404.** Meta answers `404 model_not_found` for some inputs (seen: a small box prompt)
and bills nothing for it. The adapter retries once on the uploaded file; a second 404 throws a
message with Meta's body and every object asked for (name, box), saying the cause is this input or an outage and how to tell. It
does not bisect: each successful probe costs a full SAM call ($0.07-0.10).

# Runner: staging `/inputs`

A mount marked `stage` is mounted privately under `/staged` while the sandbox starts, then copied to its public local path (for example `/staged/inputs` to `/inputs`) by `STAGE_PREPARE_SCRIPT` and `STAGE_COPY_SCRIPT` in `modal-sandbox.ts`. It runs as two commands. The first makes every directory first and lists the source once, with its exit status checked, so a listing that fails partway can't pass as complete; it prints the scratch directory. The second runs `cp --parents` in batches of 16 files, 32 at a time. Making the directories first matters: parallel `cp --parents` calls that race to create one parent directory fail with `File exists`, which surfaced as `staging /inputs failed with exit code 123` (reproduced locally in 12 of 20 copies of an 800-file nested tree; 0 of 20 after). After each pass it compares the source listing with a fresh one of the copy and re-copies only the files missing or the wrong size, up to three more passes, then fails naming them.

Staging detects a stall; it never measures elapsed time against size, because a scan can be one multi-GB file or 30,000 tiny slices (the contract allows 5 GB per file, 20 GB per scan), and every rate-derived bound failed one of them (a per-`cp` rate kills healthy large files when 32 streams share the mount's bandwidth; one `cp` per file is 10-17x slower on 30k slices). Each copy pass runs in its own process group (`setsid`), and a watchdog polls the file count and bytes under the *local* destination every 2 s, from `/`, so it never opens the mount; only the copies run inside it. The copies write their output to a file, not the exec's streams, so a `cp` that survives SIGKILL can't keep the streams open after the script exits; the file's tail goes into the error when staging fails. A pass whose progress has not changed for 60 s while copies still run is killed whole, and the next pass re-copies only the missing or wrong-size files; a pass with one stuck `cp` is caught once the other copies finish and growth stops. After the last pass staging fails naming the files. The listing step has a fixed 120 s, the one remaining duration bound (a LIST page holds 1,000 objects, so 30k files is about 30 pages); the copy step has no duration bound beyond the sandbox lifetime. The watchdog prints a heartbeat each poll, and the TS side gives up on a copy step silent for 90 s (a `cp` in an uninterruptible mount read can survive SIGKILL and hold the streams open; the script itself wedged) and on the lease `signal` aborting: `#run` takes an `AbortSignal` that rejects its pending stream reads. The failed start destroys the sandbox. Exit 124 reads `timed out after N s`, 137 `killed after N s`. The error keeps a bounded tail of the copy's stderr.

Never replace this with a whole-copy retry: the input is about 943 MB and every thread that stages gets its own copy.

Only the threads of a task whose `tasks.json` entry sets `copyInputs` stage `/inputs` (`runLayout`'s `copiesInputs`); every other thread, main included, gets the same mount read-only and uncopied (writes are refused; reads and mmap work). Reading the DICOM from a cold mount takes minutes against seconds for the parallel copy (the measurements are beside `runLayout` in `packages/harness/src/layout.ts`), but only the intake task reads it, so the copy would cost every other start and idle restart 5-16 s for nothing. A task the main agent adds takes the flag from the workflow's task of the same id.

# Runner: what `/outputs` and `/scratch` support

Both are R2 bucket mounts (`modal-sandbox.ts`), so a file is written whole, once. Rename
(`sed -i`, editors), append, in-place edits and memory-mapped writes
(`np.lib.format.open_memmap(mode="w+")`) fail there: the model builds a file under `/tmp`
(local disk, lost on a sandbox restart) and `cp`s it in. The worker and check prompts
(`prompts.ts`) and the bash tool description (`layout.ts`) say so.

**`/scratch` stays an R2 mount**, though it is only intermediate files. Two things need it to
outlive a sandbox: a long bash output is stored there for the model to open (`toolOutputPath`),
and a checkpoint's evidence may be a `scratch` file, which the host copies into the run's
evidence (`r2-evidence.ts`, a server-side copy). The restart note also promises it survives a
restart. A local `/scratch` would break all three.

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
changed is still `ThreadStale`). The main agent without `bash` gets its file's body, then the skill list and the tool index (no sandbox text). A snapshot that has `checker.md` and no `check.md` (cut before the rename) is refused at load: "This run was made by an older version of Voluma and can't be resumed; start a new run."
Format: `workflows/core/agents/AGENTS.md`.

A role's model is its file's `model` alias. `config.models` maps each alias to a provider model:
`RUNNER_MODEL_WONDER` (default `meta/muse-wonder-1.0`), `RUNNER_MODEL_OPUS`, `RUNNER_MODEL_ASTRA`
(no default; a run whose role file names an unset alias fails when it starts). `RUNNER_MODEL`, when
set, forces every alias to one model. Each configured alias's provider key is required at start. A
visitor run uses `RUNNER_VISITOR_MODEL` for every role except `main` on a visitor-safe model.

A role's thinking level is its role file's `thinking` key, else `RUNNER_THINKING` (one of Pi's
levels), else none (`"off"`). With `RUNNER_MODEL` set (every role forced onto one model, a plumbing
check), the role files' levels are ignored and `RUNNER_THINKING` alone applies (`config.modelForced`). `run.ts` passes it as the role's `thinkingLevel`, which `start-thread.ts` sets
as the Pi agent's `initialState.thinkingLevel`, so Pi sends it as `reasoning` and records it on each
History message. Pi clamps an unsupported level silently, so two checks refuse one: `main.ts` at boot
checks `RUNNER_THINKING` against every alias; `run.ts` at run start checks each
role's set level against its model (the role files load per run); both use `thinking.ts` and check
only non-off levels. Unset and `"off"` both mean no requested effort through Pi Agent, not a
guarantee that the provider disables reasoning: Muse omits `reasoning` and uses its default;
DeepSeek sends `thinking: disabled`. A role's explicit `thinking: off` overrides global `high`
without asking Muse for an unsupported effort. Visitor runs always use `"off"`. The level is
not in the log, so a resumed thread takes it from the snapshotted role file and the current config.

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
and "open" always means "cut off". A self-stop reports `released` with reason `self-stop`; a signal, `shutdown`. Neither counts toward the API's no-progress limit (the process was alive); only `lease-expired`, a runner that said nothing, does.

The next claim learns why from `claim.previousClaim` (the API records `lease-expired` itself)
and writes `claim.started {resumed, after}` right after the root's `thread.started`. The
run loop then resumes each thread still in charge, if its latest `thread.started` has no
`thread.ended` and this process hasn't started it: the worker only when it holds its task, the
check only when the task is `under-review` and it is the current check, the latest main. It
resumes with the message of `cutOffText`, naming the tool the log shows with no result, or the
no-tool form, and a tool the cut-off interrupted is answered from the log (`tools/effects.ts`).
A cut-off resume counts as no delivery and no redo.

A researcher's message reopens a finished run (`run.reopened`, `packages/contracts/src/messages.ts`)
and the next claim resumes the main agent with it, as a notice: nothing is cut off, so there is no
cut-off text. That claim's `claim.started` carries `reopened: true` instead of `after`. A thread
whose stored history cannot be resumed (a run made before `reply` existed, a changed prompt or tool
list) or whose recorded model this runner no longer allows is refused as stale and started again
(`main.<n>`); `threadModel` hands such a thread the role's model rather than failing the run. A claim answers one message: the API refuses a message to a run that is
queued or running, so no message arrives mid-claim. A correction whose main agent stops moving fails the claim (the server records
`correction.ended`) instead of skipping tasks. `/outputs` is one R2 prefix shared by every claim, so
`superviseRun` first calls `keepOutputs` (`packages/harness/src/outputs-backup.ts`, before any thread or
sandbox): the first claim of a correction whose span holds a go (only a go can lead to a write: main
has no `bash` and its work tools wait for a go; a message-only correction gets no backup, unless
the main role holds `bash`, which then backs up every span) copies the whole prefix to
`runs/<id>/corrections/<reopen id>/` (server-side `CopyObject`, `r2-outputs.ts`; a worker writes
files before it reports anything, so claim start is the earliest point that precedes every
writer) and records `outputs.backed-up`; the first claim after `correction.ended` clears
`/outputs`, copies the backup back, checks that `/outputs` matches it (key and ETag per key, both
sides `CopyObject` copies) and records `outputs.restored`. Before a restore the claim
calls `awaitOtherClaimsGone`, which re-lists the run's sandboxes of other claims until none is
live (up to 60 s): a stale sandbox could write over the restored files, so if some remain the
claim fails. Only a pending restore waits; `terminateOtherClaims` at claim start does not. A failed check throws too, and the next claim repeats the restore. The first claim of the
next `run.reopened` after a correction finished (no `correction.ended` before it) deletes its
backup and records `outputs.discarded`. `corrections` (`@voluma/contracts/fold`) is the one
reader of a correction's state (its message and go, how it closed, its backup). A thread that ended `cancelled` is never
resumed; the server cancels every thread that ran in an abandoned correction, finished ones too, so the next correction starts them fresh. A tool whose `tool.call` event was
still queued when the runner died isn't named (the log lacks it), so a runner killed within
milliseconds of a call gets the no-tool form.

The API bounds restarts with one limit (`apps/api/.context/deploy.md`); the runner has no
restart counter of its own.

# Runner: telemetry, and what an uncaught error does

The [responsiveness audit](responsiveness-audit.md) records measured history,
snapshot, evidence, live-output and provider-response bounds, with a free local
replay command. Provider normalization must yield through Pi's awaited stream
hook (`model-retry.ts`): buffered tool arguments otherwise starve heartbeat timers
even though every iterator step is async. These measurements do not bound unlimited
stored history; context compaction does not by itself bound the resume response.

`telemetry.ts` starts after startup (a failure before it still kills the process). Every line starts
with `telemetry`; on Render search the service's logs for these:

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
