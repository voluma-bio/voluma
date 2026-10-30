/**
 * Keeps `/outputs` in step with the log across a correction. `/outputs` is one mutable prefix
 * shared by every claim; the fold forgets a correction that ended unfinished
 * (`abandonedEvents`), but the files that correction wrote stay unless they are put back.
 *
 * Only a go can lead to a write: the main agent holds no `bash`, and its work tools and so every
 * worker and check it starts wait for a go (`main-tools.ts`), so a span with no go gets no backup.
 *
 * At the start of a claim, before any thread or sandbox exists:
 * 1. For each correction that ended (`correction.ended`) with a backup (`outputs.backed-up`) and
 *    no `outputs.restored`: `restore` the backup, check that every file the kept attempts
 *    reported holds the bytes it reported, then record `outputs.restored`. Cut off before the
 *    event, the next claim repeats it from the start; a file that fails the check throws, so
 *    the claim fails and the next one tries again, and nothing builds on files the log
 *    does not vouch for.
 * 2. For each correction a completed root end closed (no `correction.ended`) whose backup is
 *    neither restored nor discarded: `discard` it and record `outputs.discarded`.
 * 3. If the run is in a correction (a `run.reopened` with no end) whose span holds a go
 *    `person.message` and has no backup, `backup` and record `outputs.backed-up`. The copy is
 *    taken here, not when an attempt opens, because a worker writes into `/outputs` before it
 *    reports anything. The span starts at the earlier of the reopen and the message it is keyed
 *    to (a requeue stores its reopen after the unseen messages). A go that arrives during a
 *    claim requeues the run (`messages.ts`), so no claim acts on a go it did not see here.
 *
 * Files that were never reported (intermediates) come back too, because the backup is of the
 * whole prefix.
 */

import { abandonedEvents, fold } from "@voluma/contracts/fold";
import { fileRefsOf } from "@voluma/contracts/output";
import type { Outputs } from "./ports/outputs";
import type { Recorder } from "./recorder";

export async function keepOutputs(o: {
  runId: string;
  rootThreadId: string;
  recorder: Recorder;
  outputs: Outputs;
  signal: AbortSignal;
}): Promise<void> {
  const { runId, rootThreadId, recorder, outputs, signal } = o;
  const events = recorder.events();
  const done = new Set<string>(); // reopen ids restored or discarded
  const backedUp = new Set<string>();
  const ended: string[] = [];
  const finished: string[] = [];
  let open: { id: string; from: number } | undefined;
  for (const [i, e] of events.entries()) {
    if (e.type === "run.reopened") {
      const keyed = events.findIndex((k) => k.id === e.id.replace(/:reopened$/, ""));
      open = { id: e.id, from: keyed >= 0 ? Math.min(i, keyed) : i };
    } else if (e.type === "correction.ended" && open) {
      ended.push(open.id);
      open = undefined;
    } else if (
      e.type === "thread.ended" &&
      e.threadId === rootThreadId &&
      e.payload.status === "completed" &&
      open
    ) {
      finished.push(open.id);
      open = undefined;
    } else if (e.type === "outputs.backed-up") backedUp.add(e.payload.reopenId);
    else if (e.type === "outputs.restored" || e.type === "outputs.discarded")
      done.add(e.payload.reopenId);
  }

  for (const reopenId of ended) {
    if (!backedUp.has(reopenId) || done.has(reopenId)) continue;
    await outputs.restore(runId, reopenId, signal);
    await verify(o, events);
    await recorder.append(rootThreadId, "outputs.restored", { reopenId }, `${reopenId}:restored`);
  }
  for (const reopenId of finished) {
    if (!backedUp.has(reopenId) || done.has(reopenId)) continue;
    await outputs.discard(runId, reopenId, signal);
    await recorder.append(rootThreadId, "outputs.discarded", { reopenId }, `${reopenId}:discarded`);
  }
  if (
    open &&
    !backedUp.has(open.id) &&
    events.slice(open.from).some((e) => e.type === "person.message" && e.payload.go)
  ) {
    await outputs.backup(runId, open.id, signal);
    await recorder.append(
      rootThreadId,
      "outputs.backed-up",
      { reopenId: open.id },
      `${open.id}:backed-up`,
    );
  }
}

/** Every file the kept attempts' latest reports name must hold the sha256 they reported. */
async function verify(
  o: { runId: string; outputs: Outputs; signal: AbortSignal },
  events: ReturnType<Recorder["events"]>,
) {
  const abandoned = abandonedEvents(events);
  const kept = new Set(fold(events).tasks.flatMap((t) => (t.attemptId ? [t.attemptId] : [])));
  /** The latest report of each declared output of a kept attempt. */
  const latest = new Map<string, (typeof events)[number] & { type: "output" }>();
  for (const e of events) {
    if (e.type === "output" && !abandoned.has(e.id) && kept.has(e.payload.attemptId))
      latest.set(`${e.payload.attemptId}:${e.payload.outputId}`, e);
  }
  const wrong: string[] = [];
  for (const e of latest.values()) {
    for (const ref of fileRefsOf(e.payload.output)) {
      if (ref.root !== "outputs") continue;
      if (!(await o.outputs.holds(o.runId, e.payload.taskId, ref.path, ref.sha256, o.signal)))
        wrong.push(`${e.payload.taskId}/${ref.path}`);
    }
  }
  if (wrong.length > 0)
    throw new Error(
      `restoring /outputs after an unfinished correction left files that differ from what the kept results reported: ${wrong.join(", ")}`,
    );
}
