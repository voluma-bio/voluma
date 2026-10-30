/**
 * Keeps `/outputs` in step with the log across a correction. `/outputs` is one mutable prefix
 * shared by every claim; the fold forgets a correction that ended unfinished
 * (`abandonedEvents`), but the files that correction wrote stay unless they are put back.
 * The spans come from `correctionSpans` (fold.ts), the one reader of where a correction
 * starts and how it closed.
 *
 * Only a go can lead to a write while the main agent holds no `bash` (`main.md`): its work tools,
 * and so every worker and check it starts, wait for a go (`main-tools.ts`). So a span is backed
 * up when it holds a go, or when the main role holds `bash` (`mainWorks`), which could write on
 * a message alone.
 *
 * At the start of a claim, before any thread or sandbox exists:
 * 1. For each abandoned span (`correction.ended`) with a backup (`outputs.backed-up`) and no
 *    `outputs.restored`: `restore` the backup (the port checks `/outputs` matches it), then
 *    record `outputs.restored`. Cut off before the event, the next claim repeats it. A restore
 *    needs the earlier claim's sandboxes confirmed gone (`earlierClaimsEnded`): a stale sandbox
 *    could write over the restored files, so the claim fails instead.
 * 2. For each finished span (the next `run.reopened` came with no end) whose backup is neither
 *    restored nor discarded: `discard` it and record `outputs.discarded`.
 * 3. If the latest span is open, needs a backup and has none: `backup` and record
 *    `outputs.backed-up`. The copy is taken here, not when an attempt opens, because a worker
 *    writes into `/outputs` before it reports anything. A go that arrives during a claim
 *    requeues the run (`messages.ts`), so no claim acts on a go it did not see here.
 *
 * Files that were never reported (intermediates) come back too, because the backup is of the
 * whole prefix.
 */

import { correctionSpans } from "@voluma/contracts/fold";
import type { Outputs } from "./ports/outputs";
import type { Recorder } from "./recorder";

export async function keepOutputs(o: {
  runId: string;
  rootThreadId: string;
  recorder: Recorder;
  outputs: Outputs;
  /** The main role holds `bash`, so it can write `/outputs` with no go. */
  mainWorks: boolean;
  /** An earlier claim's sandboxes are confirmed gone (`terminateOtherClaims` succeeded). */
  earlierClaimsEnded: boolean;
  signal: AbortSignal;
}): Promise<void> {
  const { runId, rootThreadId, recorder, outputs, signal } = o;
  const events = recorder.events();
  const backedUp = new Set<string>();
  const done = new Set<string>(); // reopen ids restored or discarded
  for (const e of events) {
    if (e.type === "outputs.backed-up") backedUp.add(e.payload.reopenId);
    else if (e.type === "outputs.restored" || e.type === "outputs.discarded")
      done.add(e.payload.reopenId);
  }

  for (const span of correctionSpans(events)) {
    const { reopenId } = span;
    if (span.closed === "abandoned" && backedUp.has(reopenId) && !done.has(reopenId)) {
      if (!o.earlierClaimsEnded)
        throw new Error(
          "cannot put /outputs back: an earlier claim's sandboxes are not confirmed ended, and one could still write files",
        );
      await outputs.restore(runId, reopenId, signal);
      await recorder.append(rootThreadId, "outputs.restored", { reopenId }, `${reopenId}:restored`);
    } else if (span.closed === "finished" && backedUp.has(reopenId) && !done.has(reopenId)) {
      await outputs.discard(runId, reopenId, signal);
      await recorder.append(
        rootThreadId,
        "outputs.discarded",
        { reopenId },
        `${reopenId}:discarded`,
      );
    } else if (span.closed === "open" && !backedUp.has(reopenId) && (span.hasGo || o.mainWorks)) {
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
