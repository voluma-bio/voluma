/**
 * Feeds the run's stream into the run store: durable events, and live frames folded until their
 * durable event lands. Published at most once per animation frame: a busy run sends many per
 * second. `events` keeps its identity while only frames arrive, so the event derivations don't
 * rerun per token. Once the stream is over for good, live partials are dropped: nothing will
 * complete them. The stream of an ended run closes; a message to its AI reopens the run, so
 * `generation` reconnects from the start.
 */
import { subscribe } from "@voluma/api-client";
import type { RunEvent } from "@voluma/contracts/events";
import { applyFrame, noLive, type Settled, settle, useRunStore } from "@voluma/run-view";
import { useEffect, useRef } from "react";

export function useRunStream(runId: string, generation: number, onClosed: () => void) {
  const store = useRunStore();
  const onClosedRef = useRef(onClosed);
  onClosedRef.current = onClosed;
  useEffect(() => {
    const events: RunEvent[] = [];
    let published: RunEvent[] = [];
    let live = noLive;
    let closed = false;
    const settled: Settled = new Set();
    let frame: number | undefined;
    const publish = () => {
      frame = undefined;
      if (published.length !== events.length) published = [...events];
      store.set({ events: published, live, closed });
    };
    const schedule = () => {
      frame ??= requestAnimationFrame(publish);
    };
    const stop = subscribe(runId, {
      onEvent: (event) => {
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
        closed = true;
        publish();
        onClosedRef.current();
      },
    });
    return () => {
      stop();
      if (frame !== undefined) cancelAnimationFrame(frame);
    };
  }, [runId, store, generation]);
}
