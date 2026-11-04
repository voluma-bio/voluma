/**
 * Feeds the run's stream into the run store: its durable events, published at most once per
 * animation frame (a busy run sends many per second).
 *
 * Reconnecting keeps what was received and resumes after the last `seq`. It happens when a message
 * is sent or the run resumes and, after a backoff, when the browser gives up on the stream while
 * the run still goes (a non-200 answer, as during a deploy, closes an EventSource for good). A
 * stream the server ended because the run ended stays closed until one of those triggers changes.
 */
import { subscribe } from "@voluma/api-client";
import type { RunEvent } from "@voluma/contracts/events";
import { useRunStore } from "@voluma/run-view";
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
  const received = useRef<RunEvent[]>([]);
  const [retry, setRetry] = useState(0);
  const failures = useRef(0);

  useEffect(() => {
    const events = received.current;
    let published = events.slice();
    let frame: number | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const publish = () => {
      frame = undefined;
      if (published.length !== events.length) published = [...events];
      store.set(published);
    };
    publish();
    const stop = subscribe(
      runId,
      {
        onEvent: (event) => {
          failures.current = 0;
          events.push(event);
          frame ??= requestAnimationFrame(publish);
        },
        onClosed: (why) => {
          if (frame !== undefined) cancelAnimationFrame(frame);
          publish();
          onClosedRef.current();
          if (why === "ended" || !goingRef.current) return;
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
  }, [runId, store, reopened, going, retry]);
}
