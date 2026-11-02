/**
 * `keep_output` of the agent loop (main's): after looking at out-of-date outputs and finding they
 * still hold, publishes a new version of each with the same files and `madeFrom` rewritten to the
 * latest versions of its inputs, marked `kept` with the reason. Its files hash the same, so
 * whatever was made from it is current again (`output-fold.ts`). Nothing is copied: the new
 * version points at the folder of the one it keeps. Open To check items carry over; keeping does
 * not answer them.
 *
 * Every id is checked before the first is written. Each id has its own event id, so a call cut
 * off between two outputs finishes the rest when repeated, and ids it already kept are not
 * checked again (they are no longer out of date).
 */
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
});

export function keepOutput(deps: OutputToolDeps): Tool<typeof inputSchema> {
  const { recorder, section } = deps;
  return {
    name: "keep_output",
    description:
      "Keep out-of-date outputs after you have looked at them and they still hold. Each gets a new version with the same files, made from the latest versions of its inputs, so what was made from it is current again. Not for outputs that need redoing.",
    input: inputSchema,
    execute: ({ ids, reason }, ctx) =>
      result(() =>
        section(async () => {
          if (callerOf(deps, ctx.threadId).role !== "main")
            throw new Refusal("Only the main agent keeps outputs; tell it what you found.");
          const eventId = (id: string) => keepOutputId(ctx.threadId, ctx.toolCallId, id);
          const todo = [...new Set(ids)].filter((id) => !eventById(deps, eventId(id)));
          const fold = foldOf(deps);
          for (const id of todo) {
            const o = fold.byId.get(id);
            if (!o?.latest)
              throw new Refusal(`${id} has no published version, so there is nothing to keep.`);
            if (!o.outOfDate)
              throw new Refusal(`${id} is not out of date, so there is nothing to keep.`);
          }
          const kept: OutputEvent[] = [];
          for (const id of [...new Set(ids)]) {
            const stored = eventById(deps, eventId(id));
            if (stored?.type === "output.published") {
              kept.push(stored.payload);
              continue;
            }
            // Read now, not before the loop: an output kept earlier in this call is the latest of its id.
            const latest = foldOf(deps).byId.get(id)?.latest;
            if (!latest) throw new Error(`${id} lost its version`);
            const version = nextVersion(deps, id);
            const { kind, base } = foldOf(deps).byId.get(id) ?? {};
            if (!kind) throw new Error(`${id} has no kind`);
            const current = (other: string) =>
              other === id ? latest.version : foldOf(deps).byId.get(other)?.latest?.version;
            const payload: OutputEvent = {
              outputId: id,
              version,
              path: latest.path,
              ...(latest.files.length > 0 && { files: latest.files }),
              ...(latest.value && { value: latest.value }),
              ...(latest.evidence.length > 0 && { evidence: latest.evidence }),
              ...(latest.detail && { detail: latest.detail }),
              madeFrom: latest.madeFrom.map((l) => ({ ...l, version: current(l.id) ?? l.version })),
              ...(latest.toCheck.some((t) => !t.resolved) && {
                toCheck: latest.toCheck
                  .filter((t) => !t.resolved)
                  .map(({ title, focus }) => ({ title, ...(focus && { focus }) })),
              }),
              ...(latest.provisional && { provisional: true }),
              kind,
              ...(base && { base }),
              kept: { reason },
            };
            await recorder.append(ctx.threadId, "output.published", payload, eventId(id));
            kept.push(payload);
          }
          deps.changed();
          await deps.refreshRunFiles();
          return { kept: kept.map(answerOf) };
        }),
      ),
  };
}
