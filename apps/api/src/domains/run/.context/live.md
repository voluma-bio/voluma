# Live frames (token-level streaming)

The model's output reaches the browser as it is written, without touching the event log.
Contract: `packages/contracts/src/stream.ts`.

```
runner: pi message_update / callModel stream / bash output
  → recorder.live → LiveBatcher (≤1 post per ~80 ms, per run, drops under backlog)
  → POST /api/run/ingest/runs/:id/live {frames}      lease-checked, not stored
  → notifier.publish(runId, frame)                   in-process
  → each open GET /runs/:id/stream writes `event: live` (no `id:`)
```

- **One API replica.** `notifier` fans out in memory. A second replica would deliver
  frames only to the streams on the replica the runner posted to; it would need a shared
  bus. The durable path is unaffected.
- **No `id:` on a live frame**, so `Last-Event-ID` stays the durable `seq`. Never write an
  empty `id:` either: it resets the browser's cursor.
- **Reload mid-stream is out of scope.** Nothing replays frames: a browser that connects
  (or reconnects) while a reply is being written sees that reply only when its durable
  `message` (or, for the main thread, `wake`) lands. If this must change, either journal
  deltas as events (a retention and volume decision, and `fold` must ignore them) or cache
  each live reply's frames in the notifier and replay them after the durable page.
- **Best effort everywhere.** The batcher drops past 256 KB of unacknowledged text and
  does not retry; each stream's queue holds 2000 frames or 1 MB of text and drops the oldest. A drop
  leaves an `offset` gap, which the browser's append guard turns into "stop showing this
  partial".
- **Frames can trail their durable event** by up to a batch (~80 ms), e.g. `tool.output`
  after `tool.result`. The browser ignores a frame whose durable event it already holds.
- **The main thread's reply** streams as `text.delta` keyed by the id of its durable
  `wake` event (`<key>:wake`); the text is the JSON it answers with.
- **Redaction** is per posted body: a secret split across two frames is not caught, and a
  redacted secret changes a frame's length, so the browser drops the rest of that partial.
- **A wake asked again** after a runner restart reuses its `<key>:wake` id; a browser that
  stayed connected should reset a key's partial when a frame arrives at offset 0.
- No thread streams reasoning unless the model call asks for it (`reasoning` option in
  pi-ai); `reasoning.delta` and `message.reasoning` appear once a role does.
