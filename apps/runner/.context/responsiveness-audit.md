# Runner responsiveness audit — 2026-10-31

**A buffered model reply could still lose a healthy run after SAM moved out.**
The real Pi 1.4.0 adapter, fed locally over HTTP, delayed timers for **85,150 ms**
on 1 MiB of tool arguments and triggered the real lease's self-stop. Yielding
between provider events removes that starvation without changing the reply.
Live batching and evidence reads also had bypassable bounds; both are fixed.

This completes the candidate measurements requested by [#130]. It does **not**
prove safety for unlimited history, arbitrary provider replies, or a stalled API.
SAM was not rerun or changed: its real-run evidence already records two calls,
a 58 MB response, one claim and zero heartbeat failures.

## Scope and method

Reviewed the owners of history writes/resume, workflow snapshots, evidence,
live batching, bash output and provider parsing. Replayed each on its actual
adapter, fixed only demonstrated failures, then repeated the measurements.
Base: `origin/main` at `283a4950`, including the merged [#316] object-store
refactor. No second storage interface, compactor or history format was added.

The opt-in [probe](../src/responsiveness-probe.ts) starts a separate local HTTP
process: peer CPU and memory do not count as the runner's. It uses the real
HTTP client, Pi provider SDK, retry wrapper, lease (15 s heartbeat, 45 s
self-stop), thread resume, image-history wrapper, filesystem object store,
workflow loader and bash output collector. A 10 ms timer records maximum
**lateness**, excluding its intended interval. Wall time includes IO; it is
not event-loop blockage. The probe checks returned contents, counts, hashes
and bounds, not just successful completion. Fixed provider cases fail if
lateness reaches 1 s; other cases fail at 45 s. These are observed finite
workloads, not worst-case mathematical bounds.

No paid model, SAM, Modal sandbox, production write or R2 copy was made.
The optional archive replay only reads R2; its store throws on put/copy.

## Measured candidate bounds

Measurements below are from the integrated branch in this Linux x64 orb,
Node 26.12.1. Milliseconds are rounded. Historical estimates in the docs
repository's `work/iterate-and-review/design/evidence/findings.md` section 2
are not evidence for these results.

| Candidate and exercised size | Wall ms | Max timer late ms | Result / scope |
|---|---:|---:|---|
| Finished-history resume, 8,411,032 bytes / 295 rows | 261 | 143 | HTTP envelope parse, image wrapper and actual thread repair/resume checks; no provider call |
| Same, 67,113,584 bytes / 2,333 rows | 1,548 | 1,196 | Correct completed outcome |
| Same, 134,226,904 bytes / 4,663 rows | 2,930 | 2,383 | Correct outcome; **not** a bound on unlimited history |
| History write, four 1 MiB image blocks | 55 | 15 | Four content-addressed references persisted; stored row under 2,000 characters |
| Local unmounted evidence, exactly 64 MiB | 520 | 5 | Actual streaming hash, new filesystem copy and reread; size and copied digest verified |
| Fresh mouse workflow snapshot | 141 | 18 | 68 files, 1,314,158 bytes, 9 tasks |
| Resume same snapshot | 39 | 2 | Same files/tasks; filesystem latency, not R2 latency |
| Bash, 256 MiB from a real child process | 356 | 3 | 12,169-character result, 4,000,000-byte spill; no Modal transport measured |
| Live, single 8 MiB frame | 1 | 0 | Dropped; zero requests |
| Live, 100,000 empty distinct streams | 9 | 0 | All dropped; zero requests |
| Live, 50,000 consecutive 16-character deltas | 25 | 12 | One coalesced frame, 262,144 characters; 33,616 deltas dropped |

### Provider parsing: before/after and repeatability

Pi reparses growing tool JSON on every delta. An async iterator can drain
already buffered events through microtasks without letting heartbeat timers
run. Yielding in the consumer alone does not interrupt the provider's producer.
`model-retry.ts` now awaits any caller hook, then `setImmediate()`, through Pi's
awaited `onProviderStreamEvent` hook. The configured Meta/OpenAI Responses,
OpenAI Completions and Anthropic adapters await this hook before normalization.
No messages are trimmed or rewritten. Parsing cost remains; timer starvation
is what this fix removes.

The original local 1 MiB replay (256-byte argument deltas, 4,101 Pi events)
took 85,205 ms and delayed a timer 85,150 ms; `holdLease` stopped once and the
probe failed its zero-failure assertion. The integrated fixed replay took
83,184 ms, delayed timers at most 106 ms, preserved exact tool arguments,
and completed with seven acknowledged heartbeats / zero lease failures across
the full suite. Earlier fixed replays took 87,106 ms / 288 ms late with an
isolated peer and 103,261 ms / 252 ms late with the original peer setup; each
suite also acknowledged seven heartbeats with zero failures.

Five alternating baseline/fixed runs on the integrated base, each 256 KiB:

| Pair | Baseline wall / timer late ms | Fixed wall / timer late ms |
|---|---:|---:|
| 1 | 4,294 / 4,085 | 4,040 / 28 |
| 2 | 4,139 / 4,129 | 4,251 / 36 |
| 3 | 4,620 / 4,610 | 4,296 / 21 |
| 4 | 3,688 / 3,678 | 3,461 / 19 |
| 5 | 4,013 / 4,003 | 3,336 / 20 |

The integrated suite also exercised a single 16 MiB text delta (510 ms wall,
103 ms late) and two concurrent 256 KiB tool replies (7,137 ms wall, 28 ms
late), checking exact contents. These sizes do not prove that one unbounded
SSE line or one arbitrarily large JSON parse is safe.

### Real OA6-1RK evidence and history

Read-only archive:
`dev/runs/ce5a0f21-c948-4e20-a03f-04ff7f0e707b/run.json`
(57,121,727 bytes). Source evidence and existing content-addressed targets were
checked before replay; the small source's digest was independently verified.
These measurements use the merged object-store adapter and the evidence fix:

| Operation | Wall ms | Max timer late ms | What actually ran |
|---|---:|---:|---|
| Mounted evidence, 943,090,848 bytes | 248 | 1 | Two HEADs; existing recorded sandbox digest supplied, target already present |
| Unmounted evidence, 56,135,792 bytes | 1,728 | 21 | Actual R2 GET and streamed host hash; exact digest checked |
| Unmounted evidence, 943,090,848 bytes | 122 | 1 | HEAD then refusal; no body read |
| Largest archived thread, 10,970,181 bytes / 139 rows | 127 | 67 | Real rows through HTTP envelope and per-row JSON parsing; not full thread resume |

One heartbeat was acknowledged with zero lease failures. The mounted case is
**not** a new sandbox hash or a new R2 CopyObject measurement. R2's copy
implementation sends source/destination keys and an ETag, not the file body,
so large copying does not parse or hash the object on the runner. New-copy
network duration remains unmeasured; the local 64 MiB case above exercises
actual copying without writing the shared bucket.

## Demonstrated bound failures and fixes

- **Live output:** before the fix, one 8 MiB frame was accepted despite the
  262,144-character limit; 100,000 empty distinct streams produced 100 requests
  and took 5,482 ms to drain. A stalled post also allowed 10,000 one-character
  streams to accumulate. The batcher now checks the incoming frame against the
  remaining character budget, drops empty frames and limits buffered metadata
  to 1,000 frames (plus at most 1,000 in the single in-flight post). It remains
  best-effort: gaps stop a partial display; durable events are unchanged.
- **Evidence:** a real filesystem source initially reported as one byte could
  grow before GET or during GET; both cases previously hashed/copied 64 MiB +
  one byte successfully. GET now uses the HEAD ETag, checks its own size and
  counts streamed bytes. It cancels/refuses an oversized body before copying.
  The exact 64 MiB success case is measured above. The two mutation regressions
  omit the optional ETag to exercise the size/byte guards independently.
- Both live tests and both evidence mutation tests were run against unchanged
  implementations and failed, then passed with these fixes. The provider
  probe likewise reproduces the starvation when `--baseline` bypasses the
  production wrapper.

## Limits and #315

History remains an unpaged whole HTTP response with per-row JSON parsing.
The 128 MiB result is evidence for that workload, not an unlimited safety
claim. End RSS there was 994 MiB; the driver retains its generated source
rows, so this is neither peak production RSS nor an OOM threshold. Concurrent
larger histories were not extrapolated from it.

Open [#315] compacts the model's request context but retains old rows and
loads them on resume. It therefore does not bound the history HTTP envelope.
It also replaces the current last-two-image elision with hydration since the
latest compaction. Re-measure image-heavy resumes when that lands; do not
treat the current four-image write or its request token trigger as a bound
on all hydrated bytes. This audit does not implement a competing compactor
or a pagination/storage migration.

Current tool bounds also matter: `read_file` accepts 1 MiB; `view_image` reads
at most 64 MiB per input and returns at most four 1 MiB images. Sharp's resize
runs asynchronously, but decode cost was not benchmarked here. The measured
history write is the returned-image path, not an image-decoding benchmark.
API/database stalls, Render CPU contention and network outages are outside
these local timing measurements. SAM's accepted real-run proof is unchanged.

## Verification

`pnpm check` passed: Biome plus typecheck/test targets for all 16 projects,
including all four new mutation/batching regressions and 167 Python tests.
The integrated full probe passed with seven acknowledged heartbeats and zero
lease failures; the five-pair comparison and read-only OA6-1RK replay also
passed. Local Markdown links and `git diff --check` passed. There is no UI,
event-contract or stored-history format change.

## Reproduce without paid calls

From the repository root (temporary files are removed by the probe):

```sh
pnpm --filter @voluma/runner exec tsx src/responsiveness-probe.ts
pnpm --filter @voluma/runner exec tsx src/responsiveness-probe.ts --provider-only --compare
pnpm --filter @voluma/runner exec tsx src/responsiveness-probe.ts --provider-only --baseline
pnpm --filter @voluma/runner exec vitest run src/store-evidence.test.ts
pnpm --filter @voluma/harness exec vitest run src/live.test.ts
pnpm check
```

The baseline intentionally fails after the 1 MiB replay self-stops; allow
about two minutes. Provider URLs and credentials are hard-coded to the local
peer. The archive mode additionally needs normal R2 read credentials and an
existing exported run: `--archive=/absolute/path/run.json --archive-only`.
Do not commit the archive or credentials. It throws rather than writing a
missing target.

[#130]: https://github.com/voluma-bio/voluma/issues/130
[#315]: https://github.com/voluma-bio/voluma/pull/315
[#316]: https://github.com/voluma-bio/voluma/pull/316
