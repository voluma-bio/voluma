/**
 * The browser's run stream, `GET /runs/:id/stream` (`@voluma/contracts/stream`): the run's
 * stored events as server-sent events, `id: seq`. Resumes from `Last-Event-ID`, else
 * `?after=`. Reads are scoped by `readerOf` like any run read, so another org's run is 404.
 *
 * Each connection loops: read the log from its cursor in `seq` order, send, then wait for
 * a `notifier` wake-up or `POLL_MS`, whichever is first. The log is the only source of what
 * is sent, so a wake-up never carries data and a missed one is caught by the poll; that
 * also makes ordering, no gaps and no repeats a property of the cursor. Each read says
 * whether the run had ended in the same snapshot as its events (`eventLog.stream`), so a
 * short page from an ended run is the rest of the log and the stream closes.
 *
 * Keep-alive: a comment every `KEEPALIVE_MS`, and one at once on connect, since Railway's
 * proxy closes a response that has sent no byte and an idle one (its documented limits are
 * 5 minutes idle, 15 minutes total; the browser's `EventSource` reconnects with
 * `Last-Event-ID`). `shutdown` aborts when the API drains, so streams don't hold the drain.
 */

import { setTimeout as sleep } from "node:timers/promises";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { readerOf, requireUser, type UserEnv } from "../../domain";
import type { RunDeps } from ".";
import { afterParam, EVENTS_PAGE } from "./cursor";

/** A promise and the call that resolves it. */
function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const POLL_MS = 5_000;
const KEEPALIVE_MS = 15_000;

export function streamRoutes({ eventLog, notifier, shutdown }: RunDeps) {
  const app = new Hono<UserEnv>();
  app.use("/runs/:id/stream", requireUser);

  app.get("/runs/:id/stream", async (c) => {
    const runId = c.req.param("id");
    const reader = readerOf(c.var.user);
    let cursor = afterParam(c.req.header("Last-Event-ID") ?? c.req.query("after"));

    const first = await eventLog.stream(reader, runId, cursor, 1);
    if (!first) return c.json({ error: "not found" }, 404);
    if (first.ended && first.events.length === 0) return c.body(null, 204);

    return streamSSE(c, async (stream) => {
      // Renewed before each read, so a wake-up during the read ends the next wait at once.
      let kick = latch();
      const poke = () => kick.resolve();
      const nap = async () => {
        const timer = new AbortController();
        const timeout = sleep(POLL_MS, undefined, { signal: timer.signal }).catch(() => {});
        await Promise.race([kick.promise, timeout]);
        timer.abort();
      };

      stream.onAbort(poke);
      shutdown.addEventListener("abort", poke, { once: true });
      const off = notifier.watch(runId, poke);
      try {
        await stream.write(": connected\n\n");
        let lastWrite = Date.now();
        let ended = false;
        while (!ended && !stream.aborted && !shutdown.aborted) {
          kick = latch();
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
          if (ended) break;
          await nap();
          if (Date.now() - lastWrite >= KEEPALIVE_MS) {
            await stream.write(": keep-alive\n\n");
            lastWrite = Date.now();
          }
        }
      } finally {
        off();
        shutdown.removeEventListener("abort", poke);
      }
    });
  });

  return app;
}
