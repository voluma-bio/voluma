/**
 * The spans a run's corrections make (`messages.ts`): a `run.reopened`, its one `person.message`,
 * and what ended it. The only place correction state is derived from the log: the conversation,
 * and the API's reopen and end of a correction, read it.
 */
import type { RunEvent } from "./events";
import { threadPlace } from "./thread-place";

/**
 * One correction: what a `run.reopened` starts. A message reopens the run for one claim, so the
 * reopen and its `person.message` are written together and a span holds one message.
 */
export type Correction = {
  /** The `run.reopened` event's id. */
  reopenId: string;
  /** Index of the `run.reopened` in the log. */
  reopened: number;
  /** Index where the span stops (exclusive): its `correction.ended`, else the next reopen, else the log's end. */
  to: number;
  /**
   * `abandoned`: a `correction.ended` closed it. `finished`: the next `run.reopened` came with
   * no end between. `open`: the latest span, which a claim may still be running or have finished
   * (a finished correction leaves its span open while the run is `ended`).
   */
  closed: "abandoned" | "finished" | "open";
  /** The claim finished: the root thread ended after the reopen and the span was not abandoned. */
  claimEnded: boolean;
  /** Index of the root's latest completed `thread.ended` that `claimEnded` counts. */
  claimEndedAt: number | undefined;
};

/** Every correction of a run, in order. */
export function corrections(events: readonly RunEvent[]): Correction[] {
  const spans: Correction[] = [];
  let root: string | undefined;
  for (const [i, e] of events.entries()) {
    const span = spans.at(-1);
    switch (e.type) {
      case "run.reopened":
        if (span?.closed === "open") {
          span.closed = "finished";
          span.to = i;
        }
        spans.push({
          reopenId: e.id,
          reopened: i,
          to: events.length,
          closed: "open",
          claimEnded: false,
          claimEndedAt: undefined,
        });
        break;
      case "thread.started":
        if (threadPlace(e.payload) === "root") root = e.threadId;
        break;
      case "thread.ended":
        if (span?.closed === "open" && e.threadId === root && e.payload.status === "completed") {
          span.claimEnded = true;
          span.claimEndedAt = i;
        }
        break;
      case "correction.ended":
        if (span?.closed === "open") {
          span.closed = "abandoned";
          span.to = i;
        }
        break;
    }
  }
  return spans;
}
