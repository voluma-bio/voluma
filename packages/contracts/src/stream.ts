/**
 * The browser's run stream: `GET /api/run/runs/:runId/stream`, a
 * `text/event-stream` (cookie-authenticated; the read is scoped like any run
 * read, `run.ts`, so another org's run is 404). It carries durable events only
 * (`events.ts`): each SSE message's `data` is one `runEventSchema` JSON and its
 * `id:` is the event's `seq`. There is no snapshot on connect.
 *
 * The browser's cursor is the `id` of the last event it has. On a reconnect
 * `EventSource` sends it as `Last-Event-ID`; the first connect may pass
 * `?after=<seq>` instead (0 or absent for none; `seq` starts at 1), and the
 * header wins when both are present. The hub sends every stored event with
 * `seq > after`, oldest first, then new events as they happen. Events on one
 * connection are in strictly increasing `seq` with no gap and no repeat: the
 * hub holds back events that arrive while it reads the stored ones. So
 * `Last-Event-ID` is always a cursor with nothing missing below it, and the
 * browser needs no dedupe.
 *
 * The stream has an end. Once the run has ended and the hub has sent every stored event,
 * it sends one `event: end` message (`END_EVENT`; its `data` means nothing) and closes the
 * response, also when nothing is left after the cursor (a request for an ended run is
 * answered 200 with `end` alone). The browser closes its `EventSource` on it: the log it
 * holds is whole. Without that, `EventSource` would take the close for a drop and
 * reconnect after its retry delay (about 3 s). A non-200 status (404, 401) or a
 * non-`text/event-stream` response stops it for good. The browser sees that as
 * `readyState === CLOSED` and can then refetch the run, or call `getMe` to tell a
 * sign-out from an ended run.
 */
/** The SSE event name that ends an ended run's stream: every stored event has been sent. */
export const END_EVENT = "end";
