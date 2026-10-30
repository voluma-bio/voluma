/**
 * Keeps `/outputs` in step with the log across a correction. `/outputs` is one mutable prefix
 * shared by every claim; the fold forgets a correction that ended unfinished
 * (`abandonedEvents`), but the files that correction wrote stay unless they are put back.
 * The spans come from `corrections` (fold.ts), the one reader of where a correction
 * starts, how it closed and whether its backup was taken.
 *
 * Only a go can lead to a write while the main agent holds no `bash` (`main.md`): its work tools,
 * and so every worker and check it starts, wait for a go (`main-tools.ts`). So a span is backed
 * up when its message is a go, or when the main role holds `bash` (`mainWorks`), which could write on
 * a message alone.
 *
 * At the start of a claim, before any thread or sandbox exists:
 * 1. For each abandoned span (`correction.ended`) with a backup (`outputs.backed-up`) and no
 *    `outputs.restored`: `restore` the backup (the port checks `/outputs` matches it), then
 *    record `outputs.restored`. Cut off before the event, the next claim repeats it. Before a
 *    restore, `earlierClaimsEnded` waits until no earlier claim's sandbox is live (one could
 *    write over the restored files) and throws if some still are, which fails the claim. Only
 *    a pending restore waits.
 * 2. For each finished span (the next `run.reopened` came with no end) whose backup is neither
 *    restored nor discarded: `discard` it and record `outputs.discarded`. So is an abandoned
 *    span with no `outputs.backed-up`: a cancel can land between the copy and the event, leaving
 *    a copy no event names (nothing ran yet, so there is nothing to restore).
 * 3. If the latest span is open, needs a backup and has none: `backup` and record
 *    `outputs.backed-up`. The copy is taken here, not when an attempt opens, because a worker
 *    writes into `/outputs` before it reports anything. A claim answers one message, so the go
 *    it acts on is the one in its span.
 *
 * Files that were never reported (intermediates) come back too, because the backup is of the
 * whole prefix.
 */

import { corrections } from "@voluma/contracts/fold";
import type { Outputs } from "./ports/outputs";
import type { Recorder } from "./recorder";

export async function keepOutputs(o: {
  runId: string;
  rootThreadId: string;
  recorder: Recorder;
  outputs: Outputs;
  /** The main role holds `bash`, so it can write `/outputs` with no go. */
  mainWorks: boolean;
  /** Resolves once no earlier claim's sandbox is live; throws if some are (`awaitOtherClaimsGone`). */
  earlierClaimsEnded(signal: AbortSignal): Promise<void>;
  signal: AbortSignal;
}): Promise<void> {
  const { runId, rootThreadId, recorder, outputs, signal } = o;

  for (const { reopenId, closed, backup, go } of corrections(recorder.events()).spans) {
    if (closed === "abandoned" && backup === "backed-up") {
      await o.earlierClaimsEnded(signal);
      await outputs.restore(runId, reopenId, signal);
      await recorder.append(rootThreadId, "outputs.restored", { reopenId }, `${reopenId}:restored`);
    } else if (
      (closed === "finished" && backup === "backed-up") ||
      (closed === "abandoned" && backup === "none")
    ) {
      await outputs.discard(runId, reopenId, signal);
      await recorder.append(
        rootThreadId,
        "outputs.discarded",
        { reopenId },
        `${reopenId}:discarded`,
      );
    } else if (closed === "open" && backup === "none" && (go || o.mainWorks)) {
      await outputs.backup(runId, reopenId, signal);
      await recorder.append(
        rootThreadId,
        "outputs.backed-up",
        { reopenId },
        `${reopenId}:backed-up`,
      );
    }
  }
}
