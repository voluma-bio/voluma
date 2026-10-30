# The provider gateway

A streaming reverse proxy that sandboxes reach model and tool providers through. It adds our
key, streams bytes without holding them, and is the one place that checks a run's spend before a
call. Design (approved, with the reasons): voluma-bio/docs
`work/iterate-and-review/design/infrastructure.md` §1. This page is what a cold agent needs to
change it safely.

## Shape

- `packages/provider-calls` is shared with `apps/api`: the `provider_calls` table, the admit
  transaction, settle and `cut` updates, the run sum, the token codec, provider definitions
  (routes, auth header) and prices. The gateway imports nothing from `apps/api`; it reads the
  `runs` columns it needs by raw SQL (`calls.ts`). The migration is in `apps/api/drizzle/`.
- `src/gateway.ts` is the whole request path; `src/main.ts` reads env, builds the handle (it must
  use `drizzle(client, { casing: "snake_case" })`), checks the migration, cuts stale rows, drains.
- A request is `/<provider>/<upstream path>` with the gateway token as `Authorization: Bearer` or
  `x-api-key`. Order: open token, provider allowed, key (a visitor token has only its own keys),
  exact route, model (top level of the first 4 KB of the body) and its price, admit, forward,
  stream back, settle. The close listener is attached first, so a caller who leaves during the
  peek or admission settles the row `failed` at $0 and nothing is forwarded.

## Rules that are easy to break

- **Take the run lock in its own statement.** `admitCall` runs `SELECT … FOR UPDATE` on the run
  and only then, in later statements, sums `provider_calls`. A statement that waits for a lock
  reads other tables as of its start, so one that locks and sums together lets concurrent calls
  all pass the cap (seen: 8 calls admitted against a $10 cap).
- **Nothing is held at admission.** A call counts its `cost_usd`; null on an ended call (`cut`)
  means the cost is unknown (the provider may have billed it). A reply that was cut short is never
  priced from the usage seen so far. Spend is the sum of known costs; unknown-cost calls are
  counted apart (`providerCalls.unknownCostCalls`) and shown as "cost unknown", never as $0.
- **Only Meta is enabled** (`ProviderDef.enabled`); Anthropic and OpenAI have definitions but
  every route is a 403 until the gate in [TODO.md](TODO.md) is met.
- **The body is the caller's.** `body.ts` reads `model` as a top-level key only,
  and one scanner runs over the whole body as it is forwarded, in constant memory. The first 4 KB
  must hold a top-level `model` (else 403); a repeated `model` key anywhere, or an
  escaped top-level key, refuses at admission or, past 4 KB, errors the upstream stream so the
  call settles `cut`. Never read a price-relevant field from a body by regex.
- **A null `runs.cost_cap_usd` is no spend cap.** Admission skips the spend check; the in-flight
  limit, exact routes and model allowlist still apply, and every call is still recorded. With a
  cap, admission refuses (402) once known spend (model cost plus known call costs) has reached it;
  calls in flight and cut calls count nothing, so the cap can be passed by what is already running.
  The heartbeat's `spentUsd`, `providerCalls` and the org's daily total use the same known sum.
  `provider_calls.reserved_usd` is unused (drop: `apps/api/.context/TODO.md`).
- **Exact routes** (`providers.ts`). A path with `%`, `..`, `.` or `//` segments is refused, not
  normalized. Anthropic and OpenAI have message routes only; their Files and Batches APIs stay
  closed because every run shares the account. A Meta `DELETE /v1/files/{id}` needs an id this
  run uploaded (recorded on the upload's row).
- **A model without a price is refused** (Pi's catalog, plus SAM by frame).
- **Reading usage is bounded** (`scan.ts`, `observe.ts`): an event stream is read by line, any
  other reply as one text, each cut to its last 64 KB, and numbers are read by pattern (whitespace
  allowed) from the last unescaped `"usage":{`. An Anthropic or Responses stream that ends before
  its last event (`message_stop`, `response.completed`) is `cut`, not `done`. Nothing from a body is stored
  or logged.
- **In-flight limit** is 4 per run and sandbox name, and applies to every token for now. The
  runner's own tokens (design step 7) will need an exemption.
- **Call length.** A call is aborted at `MAX_CALL_MS` (30 minutes, headers wait and stream
  together) and ends `cut`. So an `open` row older than 40 minutes (the bound plus a 10-minute
  margin) belongs to no live call, and `cutStaleCalls` runs at boot and every 5 minutes. A newer
  row may belong to an old instance still draining, so it is left alone. A settle is tried three
  times before the row is left to that sweep.
- **Boot and shutdown.** While draining, new calls get 503 with `Connection: close`. At SIGTERM
  the instance drains for `GATEWAY_DRAIN_SECONDS`, aborts what remains (those calls end `cut`),
  then marks its own leftover `open` rows `cut`. The gateway exits at boot if `provider_calls` or
  `runs.cost_cap_usd` is missing.

## Known limits

- The model name must appear in the first 4 KB. A `model` repeated after that cuts the call
  mid-upload, so the provider has seen part of the body and may have billed it (its cost stays unknown).
- The row for a call exists once admitted; if the database is down the call is refused (503).
  A settle that still fails after its retries leaves the row `open` (counting nothing)
  until the stale sweep, which cuts it.

## Not built yet

The runner's own model calls through the gateway (design step 7, which also retires the runner's
meter), and OpenAI/Anthropic route use by sandboxes (see [TODO.md](TODO.md) for what enabling needs). No live provider call has been made from
this code: tests ran against local stubs only.
