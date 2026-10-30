/**
 * Feeds the run's stream into the run store: durable events, and live frames folded until their
 * durable event lands. Published at most once per animation frame: a busy run sends many per
 * second. `events` keeps its identity while only frames arrive, so the event derivations don't
 * rerun per token. Once the stream is over for good, live partials are dropped: nothing will
 * complete them.
 *
 * Reconnecting keeps what was received and resumes after the last `seq`. It happens when
 * `reopened` changes (a message reopened an ended run, whose stream had closed) and, after a
 * backoff, when the browser gives up on the stream while the run still goes (a non-200 answer,
 * as during a deploy, closes an EventSource for good).
 */
import { subscribe } from "@voluma/api-client";
import type { RunEvent } from "@voluma/contracts/events";
import { applyFrame, noLive, type Settled, settle, useRunStore } from "@voluma/run-view";
import { useEffect, useRef, useState } from "react";

const BACKOFF_MS = [1000, 2000, 5000, 10_000, 30_000];

export function useRunStream(
  runId: string,
  { reopened, going, onClosed }: { reopened: number; going: boolean; onClosed: () => void },
) {
  const store = useRunStore();
  const onClosedRef = useRef(onClosed);
  onClosedRef.current = onClosed;
  const goingRef = useRef(going);
  goingRef.current = going;
  // What every connection of this run adds to; the store is keyed on the run.
  const received = useRef<{ events: RunEvent[]; settled: Settled }>({
    events: [],
    settled: new Set(),
  });
  const [retry, setRetry] = useState(0);
  const failures = useRef(0);

  useEffect(() => {
    const { events, settled } = received.current;
    let published = events.slice();
    let live = noLive;
    let frame: number | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const publish = (closed: boolean) => {
      frame = undefined;
      if (published.length !== events.length) published = [...events];
      store.set({ events: published, live, closed });
    };
    const schedule = () => {
      frame ??= requestAnimationFrame(() => publish(false));
    };
    publish(false);
    const stop = subscribe(
      runId,
      {
        onEvent: (event) => {
          failures.current = 0;
          events.push(event);
          live = settle(live, event, settled);
          schedule();
        },
        onLive: (f) => {
          const next = applyFrame(live, f, settled);
          if (next === live) return;
          live = next;
          schedule();
        },
        onClosed: () => {
          if (frame !== undefined) cancelAnimationFrame(frame);
          live = noLive;
          publish(true);
          onClosedRef.current();
          if (!goingRef.current) return;
          const wait = BACKOFF_MS[Math.min(failures.current, BACKOFF_MS.length - 1)];
          failures.current += 1;
          timer = setTimeout(() => setRetry((n) => n + 1), wait);
        },
      },
      events.at(-1)?.seq ?? 0,
    );
    return () => {
      stop();
      if (frame !== undefined) cancelAnimationFrame(frame);
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [runId, store, reopened, retry]);
}
