/**
 * The browser's run stream, `GET /runs/:id/stream` (`@voluma/contracts/stream`): the run's
 * stored events as server-sent events, `id: seq`. Resumes from `Last-Event-ID`, else
 * `?after=`. Reads are scoped by `readerOf` like any run read, so another org's run is 404.
 *
 * Each connection loops: read the log from its cursor in `seq` order, send, then wait for
 * `eventLog.onAppend` or `POLL_MS`, whichever is first. The log is the only source of what
 * is sent, so a wake-up never carries data and a missed one is caught by the poll; that
 * also makes ordering, no gaps and no repeats a property of the cursor. The run's end is
 * read *before* each read of the log: events cannot be appended after a run ends, so
 * "ended, then drained" means everything was sent, and the stream closes.
 *
 * Keep-alive: a comment every `KEEPALIVE_MS`, and one at once on connect, since Railway's
 * proxy closes a response that has sent no byte and an idle one (its documented limits are
 * 5 minutes idle, 15 minutes total; the browser's `EventSource` reconnects with
 * `Last-Event-ID`). `shutdown` aborts when the API drains, so streams don't hold the drain.
 */

import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { streamSSE } from "hono/streaming";
import { readerOf, requireUser, type UserEnv } from "../../domain";
import type { RunDeps } from ".";

const PAGE = 500;
const POLL_MS = 5_000;
const KEEPALIVE_MS = 15_000;

function cursorOf(header: string | undefined, query: string | undefined): number {
  const raw = header ?? query ?? "0";
  if (!/^\d{1,9}$/.test(raw)) throw new HTTPException(400, { message: "bad cursor" });
  return Number(raw);
}

export function streamRoutes({ reads, eventLog, shutdown }: RunDeps) {
  const app = new Hono<UserEnv>();
  app.use("/runs/:id/stream", requireUser);

  app.get("/runs/:id/stream", async (c) => {
    const runId = c.req.param("id");
    const reader = readerOf(c.var.user);
    let cursor = cursorOf(c.req.header("Last-Event-ID"), c.req.query("after"));

    const ended = await reads.hasEnded(reader, runId);
    if (ended === null) return c.json({ error: "not found" }, 404);
    if (ended && (await eventLog.after(runId, cursor, 1)).length === 0) return c.body(null, 204);

    return streamSSE(c, async (stream) => {
      let wake: (() => void) | null = null;
      let pending = false;
      const poke = () => {
        pending = true;
        wake?.();
      };
      const wait = (ms: number) =>
        new Promise<void>((resolve) => {
          if (pending) return resolve();
          const done = () => {
            clearTimeout(timer);
            wake = null;
            resolve();
          };
          const timer = setTimeout(done, ms);
          wake = done;
        });

      stream.onAbort(poke);
      shutdown.addEventListener("abort", poke, { once: true });
      const off = eventLog.onAppend(runId, poke);
      try {
        await stream.write(": connected\n\n");
        let lastWrite = Date.now();
        while (!stream.aborted && !shutdown.aborted) {
          const isEnded = await reads.hasEnded(reader, runId);
          if (isEnded === null) break;
          pending = false;
          for (;;) {
            const page = await eventLog.after(runId, cursor, PAGE);
            for (const event of page) {
              await stream.writeSSE({ id: String(event.seq), data: JSON.stringify(event) });
              cursor = event.seq;
            }
            if (page.length > 0) lastWrite = Date.now();
            if (page.length < PAGE) break;
          }
          if (isEnded) break;
          await wait(POLL_MS);
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
