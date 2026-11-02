/**
 * `keep_output` of the agent loop (main's): after looking at out-of-date outputs and finding they
 * still hold, publishes a new version of each with the same files and `madeFrom` rewritten to the
 * latest versions of its inputs, marked `kept` with the reason. Its files hash the same, so
 * whatever was made from it is current again (`output-fold.ts`). Nothing is copied: the new
 * version points at the folder of the one it keeps. Open To check items carry over; keeping does
 * not answer them.
 *
 * With `toCheck`, the new versions also carry those To check items: how main leaves a result to
 * the researcher (`leaveToResearcher` does the same when the researcher declined a keep or redo).
 *
 * Every id is checked before the first is written. Each id has its own event id, so a call cut
 * off between two outputs finishes the rest when repeated, and ids it already kept are not
 * checked again (they are no longer out of date).
 */
import { toCheckItemSchema } from "@voluma/contracts/agent-events";
import { outputRefSchema } from "@voluma/contracts/output-catalog";
import { z } from "zod";
import type { Tool } from "../../tools/tool";
import { keepOutputId } from "../effects";
import {
  answerOf,
  callerOf,
  eventById,
  foldOf,
  nextVersion,
  type OutputEvent,
  type OutputToolDeps,
} from "./output-shared";
import { Refusal, result } from "./refusal";

const inputSchema = z.object({
  ids: z
    .array(outputRefSchema)
    .min(1)
    .describe("Out-of-date outputs you looked at and found still correct."),
  reason: z
    .string()
    .min(1)
    .describe(
      "Why they still hold, in plain words the researcher can read: what changed beneath them and why it does not matter here.",
    ),
  toCheck: z
    .array(toCheckItemSchema)
    .optional()
    .describe(
      "To leave them to the researcher instead of vouching for them: what a person must judge, {title, focus?}. They are kept as they are and show as to check.",
    ),
});

/** The refusal for an id that cannot be kept, or undefined. */
function keepRefusal(deps: OutputToolDeps, id: string): string | undefined {
  const o = foldOf(deps).byId.get(id);
  if (!o?.latest) return `${id} has no published version, so there is nothing to keep.`;
  if (!o.outOfDate) return `${id} is not out of date, so there is nothing to keep.`;
  return undefined;
}

/**
 * Publishes the kept version of `id`: the latest one's files, `madeFrom` moved to the latest
 * versions of its inputs, its open To check items and `toCheck`. Call inside the section.
 */
async function keep(
  deps: OutputToolDeps,
  threadId: string,
  eventId: string,
  id: string,
  kept: NonNullable<OutputEvent["kept"]>,
  toCheck: readonly { title: string; focus?: unknown }[] = [],
): Promise<OutputEvent> {
  // Read now, not before a loop: an output kept earlier in the call is the latest of its id.
  const fold = foldOf(deps);
  const latest = fold.byId.get(id)?.latest;
  if (!latest) throw new Error(`${id} lost its version`);
  const { kind, base } = fold.byId.get(id) ?? {};
  if (!kind) throw new Error(`${id} has no kind`);
  const current = (other: string) =>
    other === id ? latest.version : fold.byId.get(other)?.latest?.version;
  const open = [
    ...latest.toCheck.filter((t) => !t.resolved).map(({ title, focus }) => ({ title, focus })),
    ...toCheck,
  ];
  const payload: OutputEvent = {
    outputId: id,
    version: nextVersion(deps, id),
    path: latest.path,
    ...(latest.files.length > 0 && { files: latest.files }),
    ...(latest.value && { value: latest.value }),
    ...(latest.evidence.length > 0 && { evidence: latest.evidence }),
    ...(latest.detail && { detail: latest.detail }),
    madeFrom: latest.madeFrom.map((l) => ({ ...l, version: current(l.id) ?? l.version })),
    ...(open.length > 0 && {
      toCheck: open.map(({ title, focus }) => ({ title, ...(focus ? { focus } : {}) })),
    }),
    ...(latest.provisional && { provisional: true }),
    kind,
    ...(base && { base }),
    kept,
  } as OutputEvent;
  await deps.recorder.append(threadId, "output.published", payload, eventId);
  return payload;
}

/**
 * The researcher declined a keep or redo of `id`: it is kept as it is and left to them, with one
 * To check item saying what changed beneath it and that nobody has re-checked it. Called by the
 * loop inside its step, with the thread that made the call; a repeat finds the event by `eventId`.
 */
export async function leaveToResearcher(
  deps: OutputToolDeps,
  threadId: string,
  eventId: string,
  id: string,
): Promise<boolean> {
  if (eventById(deps, eventId)) return false;
  const fold = foldOf(deps);
  const o = fold.byId.get(id);
  if (!o?.latest || !o.undecided) return false;
  const stale = o.latest.madeFrom.find((l) => {
    if (l.id === id) return false;
    const now = fold.byId.get(fold.labels.get(l.id) ?? l.id)?.latest?.version;
    return now !== undefined && now !== l.version;
  });
  const why = stale
    ? `Made from ${stale.id} v${stale.version}, since replaced by v${fold.byId.get(fold.labels.get(stale.id) ?? stale.id)?.latest?.version}; `
    : "Something it was made from changed; ";
  await keep(deps, threadId, eventId, id, { reason: "left to the researcher" }, [
    { title: `${why}the AI's keep or redo was declined, so this has not been re-checked.` },
  ]);
  return true;
}

export function keepOutput(deps: OutputToolDeps): Tool<typeof inputSchema> {
  const { recorder, section } = deps;
  return {
    name: "keep_output",
    description:
      "Keep out-of-date outputs after you have looked at them and they still hold. Each gets a new version with the same files, made from the latest versions of its inputs, so what was made from it is current again. Not for outputs that need redoing.",
    input: inputSchema,
    changesResults: {
      preflight: (input, ctx) =>
        section(async () => {
          if (callerOf(deps, ctx.threadId).role !== "main")
            throw new Refusal("Only the main agent keeps outputs; tell it what you found.");
          for (const id of new Set(input.ids)) {
            const why = keepRefusal(deps, id);
            if (why) throw new Refusal(why);
          }
        }),
    },
    execute: ({ ids, reason, toCheck }, ctx) =>
      result(() =>
        section(async () => {
          if (callerOf(deps, ctx.threadId).role !== "main")
            throw new Refusal("Only the main agent keeps outputs; tell it what you found.");
          const eventId = (id: string) => keepOutputId(ctx.threadId, ctx.toolCallId, id);
          // Ids kept by an earlier try of this call are no longer out of date.
          for (const id of [...new Set(ids)].filter((id) => !eventById(deps, eventId(id)))) {
            const why = keepRefusal(deps, id);
            if (why) throw new Refusal(why);
          }
          const kept: OutputEvent[] = [];
          for (const id of [...new Set(ids)]) {
            const stored = eventById(deps, eventId(id));
            kept.push(
              stored?.type === "output.published"
                ? stored.payload
                : await keep(deps, ctx.threadId, eventId(id), id, { reason }, toCheck),
            );
          }
          deps.changed();
          await deps.refreshRunFiles();
          return { kept: kept.map(answerOf) };
        }),
      ),
  };
}
