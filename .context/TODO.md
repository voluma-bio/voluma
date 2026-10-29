# TODO

Deferred repo-wide work. Lane-specific items go in that directory's
`.context/TODO.md`; cross-lane items go in GitHub issues.

Contracts, written when something produces or consumes them (the first contracts PR covers the R2 key layout, the v0 event kinds and the review data):
- A command map (name → zod input and output), including the review corrections (a request, and a proposal of what it would redo); `api-client` becomes one generic typed `call(name, input)` and `subscribe(runId)` over HTTP, so a new command needs no `api-client` edit.
- The `compaction` event kind, when something produces it.
- An importer that turns the real OA6-1RK reference run into the review-data format, so the Review lane works on real data from day one. No hand-made fixtures.

Later:
- `pnpm data:pull`: fetch the OA6-1RK scan and reference run from R2 into `.data/`. Both lanes need it from day one; blocked on the bucket existing.
- Nx 24 and TypeScript 7 are released; the workspace is on Nx 23 and TypeScript 6. Upgrade in their own PR and check `pnpm check` timings.
- Harness: live tool output flushes only when the next chunk arrives, so a command that prints once and then goes quiet shows nothing live until it ends. Add a timer flush when the live stream (PR F) needs it.
- Harness: a `bash` result stores at most 4 MB of output (`STORE_CHARS` in `tools/bash.ts`; the tail is always shown); the note says when the stored copy is cut. A tool that returns large files should write them to `/outputs` instead; revisit if a real task needs more.
- Harness: move `EventLog`, `History` and `HistoryConflict` out of `@voluma/harness` so `apps/api` stops depending on it (it drags Pi's dependency tree into the API package). The history wire schemas are already in `@voluma/contracts/history`.
- Harness: on a Claude refusal (`rawStopReason: "refusal"`), retry the turn on Claude Opus 4.8 to stay on Claude, or fall back to Astra; today a refusal ends the thread as failed.
- Harness: first real-model run (OpenAI and Claude) on the OA6-1RK task: see the PR for what has and hasn't been run.
- Harness, PR F (stream hub): split the recorder's delivery by kind. Durable events (`thread.*`, `tool.call`, `tool.result`, `message`, `sandbox`) go on an ordered queue that never gives up silently before a `flush` deadline, and at the deadline fails the run visibly (today a durable event that exhausts its 5 attempts is dropped and leaves the `threads` projection stale). Live frames (`@voluma/contracts/stream`: text and tool-argument deltas, tool output chunks) go to the hub over a bounded drop-oldest channel that never waits behind the durable queue; the runner must also pick each reply's `messageId` as the id of its `message` event. Until then `ToolContext.output` goes nowhere. The console printer in `apps/runner/src/main.ts` becomes a listener instead of a wrapper on `append`, so it prints while the API is down.
- Harness: a resumed run must give the recorder the run's stored events (`recorder(..., stored)`), which needs an events read on `EventLog`, the ingest route and the HTTP client. Until then a resume works only where the caller supplies the stored events (the resume proof used a file-backed log and History).
- Harness: the R2 `Evidence` adapter (copy from the run's mounts to `evidenceKey(runId, sha256)`); only a local one (`adapters/local/evidence.ts`, a directory as the bucket) exists. Lane E wires it.
- Harness: the run loop's `threadLog` (and the fold inside it) is derived from the whole log on each change of the log, so a run costs quadratic in its events; fine for hundreds, revisit with the first long run. `threadLog` is a left fold, so it can resume from its cached state and length once the fold does too.
- Harness: `/inputs` is a writable local copy. Commands run as root, and the sandbox grants no capability to remount or `chattr` it; a non-root user cannot write the FUSE mounts. Revisit if a model edits inputs: mount the staged copy read-only through the image or a mount option.
