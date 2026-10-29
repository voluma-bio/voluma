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
  exact route, model (first 4 KB of the body) and its price, admit, forward, stream back, settle.

## Rules that are easy to break

- **Take the run lock in its own statement.** `admitCall` runs `SELECT … FOR UPDATE` on the run
  and only then, in later statements, sums `provider_calls`. A statement that waits for a lock
  reads other tables as of its start, so one that locks and sums together lets concurrent calls
  all pass the cap (seen: 8 calls admitted against $10 with $3 reservations).
- **A call counts its cost, else its reservation** (`cost_usd` null = unknown, may still be
  billed). `open` and `cut` rows keep the reservation. A reply that was cut short is never priced
  from the usage seen so far; it keeps the reservation.
- **Exact routes** (`providers.ts`). A path with `%`, `..`, `.` or `//` segments is refused, not
  normalized. Anthropic and OpenAI have message routes only; their Files and Batches APIs stay
  closed because every run shares the account. A Meta `DELETE /v1/files/{id}` needs an id this
  run uploaded (recorded on the upload's row).
- **A model without a price is refused** (Pi's catalog, plus SAM by frame). The reservation is
  `max_tokens` at the output price (SAM: 15,000 frames, $3).
- **Reading usage is bounded** (`scan.ts`, `observe.ts`): lines are cut to their last 64 KB and
  numbers are read by pattern from the last unescaped `"usage":{`. Nothing from a body is stored
  or logged.
- **In-flight limit** is 4 per run and sandbox name, and applies to every token for now. The
  runner's own tokens (design step 7) will need an exemption.
- **Boot and shutdown.** At boot only `open` rows older than 40 minutes (30-minute upstream
  timeout plus margin) become `cut`: a still-draining old instance owns newer ones. At SIGTERM
  the instance drains for `GATEWAY_DRAIN_SECONDS`, aborts what remains (those calls end `cut`),
  then marks its own leftover `open` rows `cut`. The gateway exits at boot if `provider_calls` or
  `runs.cost_cap_usd` is missing.

## Known limits

- The model name is read from the first 4 KB, as designed. A body that repeats `"model"` later
  can differ from what is priced; SAM is billed by the frames Meta reports, so its cost is
  right either way, but a different model name on a Meta route is refused only by the first key.
- The row for a call exists once admitted; if the database is down the call is refused (503).
  A settle that fails leaves the row `open` (and counting its reservation) until a `cut`.

## Not built yet

The runner's own model calls through the gateway (design step 7, which also retires the runner's
meter), and OpenAI/Anthropic route use by sandboxes. No live provider call has been made from
this code: tests ran against local stubs only.
