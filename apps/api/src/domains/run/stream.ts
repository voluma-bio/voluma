/**
 * The browser's run stream, `GET /runs/:id/stream` (`@voluma/contracts/stream`): the run's
 * stored events as server-sent events, `id: seq`. Resumes from `Last-Event-ID`, else
 * `?after=`. Reads are scoped like any run read (`requireReader`), so another org's run is 404;
 * the debug token reads every lab's runs, for agents debugging a run.
 *
 * Each connection loops: read the log from its cursor in `seq` order, send, then wait for
 * a `notifier` wake-up or `POLL_MS`, whichever is first. The log is the only source of what
 * is sent, so a wake-up never carries data and a missed one is caught by the poll; that
 * also makes ordering, no gaps and no repeats a property of the cursor. Each read says
 * whether the run had ended in the same snapshot as its events (`eventLog.stream`), so a
 * short page from an ended run is the rest of the log: the stream sends `event: end` and closes.
 *
 * Live frames (`notifier.publish`, from the runner's `/ingest/.../live`) are written between
 * log reads as `event: live` with no `id:`; they are not read from the log, and a frame is
 * sent only to streams open when it arrives. A live frame wakes the loop without a log read.
 *
 * Keep-alive: a comment every `KEEPALIVE_MS`, and one at once on connect, since a host
 * proxy may close a response that has sent no byte, or an idle one (Railway's did at 5 minutes
 * idle and 15 minutes total; Render documents only a 100-minute cap on a response). The
 * browser's `EventSource` reconnects with `Last-Event-ID`. `shutdown` aborts when the API drains, so streams don't hold the drain.
 */

import { setTimeout as sleep } from "node:timers/promises";
import { END_EVENT, LIVE_EVENT, type LiveFrame } from "@voluma/contracts/stream";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { type AppEnv, requireReader } from "../../domain";
import type { RunDeps } from ".";
import { afterParam, EVENTS_PAGE } from "./cursor";

function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const POLL_MS = 5_000;
const KEEPALIVE_MS = 15_000;
// A stream that can't keep up drops its oldest frames past either bound.
const LIVE_QUEUE_MAX = 2_000;
const LIVE_QUEUE_MAX_CHARS = 1024 * 1024;

export function streamRoutes({ eventLog, notifier, shutdown }: RunDeps) {
  const app = new Hono<AppEnv>();

  app.get("/runs/:id/stream", requireReader, async (c) => {
    const runId = c.req.param("id");
    const reader = c.var.reader;
    let cursor = afterParam(c.req.header("Last-Event-ID") ?? c.req.query("after"));

    const first = await eventLog.stream(reader, runId, cursor, 1);
    if (!first) return c.json({ error: "not found" }, 404);

    return streamSSE(c, async (stream) => {
      // Renewed before each read, so a wake-up during the read ends the next wait at once.
      let wake = latch();
      let reread = true; // a durable wake-up (or the poll) since the last read
      const poke = () => {
        reread = true;
        wake.resolve();
      };
      // Live frames wait here for the loop, so only the loop writes to the response. A
      // stream that can't keep up loses the oldest; the browser's offset guard copes.
      let live: LiveFrame[] = [];
      let liveChars = 0;
      const sizeOf = (f: LiveFrame) => f.text.length;
      const onLive = (frame: LiveFrame) => {
        live.push(frame);
        liveChars += sizeOf(frame);
        while (live.length > LIVE_QUEUE_MAX || liveChars > LIVE_QUEUE_MAX_CHARS) {
          liveChars -= sizeOf(live.shift() as LiveFrame);
        }
        wake.resolve();
      };
      const nap = async () => {
        const timer = new AbortController();
        const timeout = sleep(POLL_MS, undefined, { signal: timer.signal }).then(
          () => {
            reread = true; // the backstop for a missed wake-up
          },
          () => {},
        );
        await Promise.race([wake.promise, timeout]);
        timer.abort();
      };

      stream.onAbort(poke);
      shutdown.addEventListener("abort", poke, { once: true });
      const offWake = notifier.watch(runId, poke);
      const offLive = notifier.watchLive(runId, onLive);
      try {
        await stream.write(": connected\n\n");
        let lastWrite = Date.now();
        let ended = false;
        while (!ended && !stream.aborted && !shutdown.aborted) {
          wake = latch();
          if (reread) {
            reread = false;
            for (;;) {
              const read = await eventLog.stream(reader, runId, cursor, EVENTS_PAGE);
              if (!read) return;
              for (const event of read.events) {
                await stream.writeSSE({ id: String(event.seq), data: JSON.stringify(event) });
                cursor = event.seq;
              }
              if (read.events.length > 0) lastWrite = Date.now();
              if (read.events.length < EVENTS_PAGE) {
                ended = read.ended;
                break;
              }
            }
            if (ended) {
              // A browser that saw only the close would reconnect.
              await stream.writeSSE({ event: END_EVENT, data: "end" });
              break;
            }
          }
          // No `id:`: a live frame must not move the browser's `Last-Event-ID` off the durable `seq`.
          const frames = live;
          live = [];
          liveChars = 0;
          for (const frame of frames) {
            await stream.writeSSE({ event: LIVE_EVENT, data: JSON.stringify(frame) });
          }
          if (frames.length > 0) lastWrite = Date.now();
          if (live.length > 0) continue;
          await nap();
          if (Date.now() - lastWrite >= KEEPALIVE_MS) {
            await stream.write(": keep-alive\n\n");
            lastWrite = Date.now();
          }
        }
      } finally {
        offWake();
        offLive();
        shutdown.removeEventListener("abort", poke);
      }
    });
  });

  return app;
}
