/**
 * What the run page and the 3D panel's chat both decide about a run that a message can reopen:
 * when its closed event stream opens again, and whether the next move is the researcher's.
 */
import type { RunEvent } from "@voluma/contracts/events";
import { corrections } from "@voluma/contracts/fold";
import type { RunState } from "@voluma/contracts/run";
import { useEffect, useRef } from "react";

/** When a run's stream closed, and how many closes in a row were errors with no event between. */
export type StreamClosed = { at: number; failures: number };

/**
 * Calls `reopen` once a read of the run made after the stream closed (`readAt`, the query's
 * `dataUpdatedAt`) says the run isn't ended: a message reopened it, or the stream failed
 * mid-claim. A run read from before the close can't say, so the stream never reopens on it:
 * a claim's end reaches the stream before the next poll does. Errors in a row (a 502 while
 * the API deploys) wait 1 s, 2 s, 4 s… up to 30 s after the first.
 *
 * Once the run has ended, a stream that closed on an error reopens once more, for the events
 * it missed if it failed before the claim ended. Only once: the server answers 204 when nothing
 * was missed, which `EventSource` reports as an error too.
 */
export function useStreamReopen(
  closed: StreamClosed | null,
  status: RunState["status"] | undefined,
  readAt: number,
  reopen: () => void,
) {
  const retriedEnded = useRef(false);
  useEffect(() => {
    if (status !== "ended") retriedEnded.current = false;
    if (!closed || status === undefined || readAt <= closed.at) return;
    const ended = status === "ended";
    if (ended && (closed.failures === 0 || retriedEnded.current)) return;
    const wait = closed.failures > 1 ? Math.min(30_000, 1000 * 2 ** (closed.failures - 2)) : 0;
    const timer = setTimeout(
      () => {
        retriedEnded.current = ended;
        reopen();
      },
      closed.at + wait - Date.now(),
    );
    return () => clearTimeout(timer);
  }, [closed, status, readAt, reopen]);
}

/**
 * "Waiting on you": the run has ended, and the AI replied in the latest correction, which asked
 * no go or whose go already redid its task. The researcher sends another note or a go.
 */
export function waitingOnYou(status: RunState["status"], events: readonly RunEvent[]): boolean {
  const { open } = corrections(events);
  if (status !== "ended" || !open) return false;
  // TODO(#223): read `open.replied` once corrections() carries it.
  const replied = events.slice(open.reopened, open.to).some((e) => e.type === "reply");
  return replied && (open.go === undefined || open.go.redone);
}
