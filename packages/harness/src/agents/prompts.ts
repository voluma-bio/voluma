/**
 * The agent loop's prompts. A thread's system prompt is fixed for its life: its role file, the
 * words and environment text every role shares, the mounts of its layout and the skill list; the
 * review main's also ends with the `researcher` skill and `review.md`. What
 * varies goes in its first message, built from the run's snapshot and the log, so a thread that
 * never stored its prompt rebuilds it identically. Everything here is generic: a workflow's
 * words come only from its skill, `outputs.yaml` and the notes it is handed.
 */
import type { AgentsDefinition, Skill } from "@voluma/workflow/definition";
import type { ThreadLayout } from "../layout";
import { skillList, toolIndex } from "../prompts";

/** The paths every agent reads; the layout (`layout.ts`) and the run files writer make them true. */
const FINAL_OUTPUTS = "/run/final-outputs.yaml";
const OUTPUTS_INDEX = "/run/outputs.yaml";
const PLAN = "/work/main/plan.md";
const MAIN_TRANSCRIPT = "/work/main/transcript.md";

export function systemPromptOf({
  definition,
  layout,
  review,
}: {
  definition: AgentsDefinition;
  layout: ThreadLayout;
  /** The review main (`AgentRecord.review`): the run is finished and main continues it with the researcher. */
  review?: boolean;
}): string {
  const role = definition.agents[layout.role];
  if (!role) throw new Error(`${layout.name} runs on ${layout.role}, which is not a role file`);
  const skills = `${skillList(definition, role, " [in your first message]", review ? ["researcher"] : [])}\n\n${toolIndex(definition, role, role.tools.includes("bash"))}`;
  const researcher = definition.skills.find((s) => s.name === "researcher");
  return [
    role.body,
    definition.words,
    definition.environment,
    layout.description,
    skills,
    ...(review ? [...(researcher ? [skillBlock(researcher)] : []), reviewText(definition)] : []),
  ].join("\n\n");
}

/**
 * `review.md`, or in a snapshot cut before it existed the `corrections` skill's text, which it moved.
 * Delete the fallback once no run predates `review.md` (`packages/harness/.context/TODO.md`).
 */
function reviewText(definition: AgentsDefinition): string {
  const text = definition.review ?? definition.skills.find((s) => s.name === "corrections")?.text;
  if (text === undefined)
    throw new Error("this run's snapshot has no review.md and no corrections skill");
  return text;
}

/** What a review main starts from (`handoverText`). */
export interface Handover {
  summary: string;
  /** The delivery owed to it (`deliveryOf`): the researcher's message, notices, agents, what is out of date. */
  delivery: string;
}

/** The summary of a handover that could not be written. */
export const NO_SUMMARY = "(no summary: read the plan and the transcript)";

/** What the main before a review main is asked to write (the cold summary call of `adapters/pi/compaction.ts`). */
export const HANDOVER_INSTRUCTION = `Stop working on the task. Do not call any tool. The run is finished and the researcher is about to review it with a new main, which starts from what you write now and the run's files. Write its handover. Treat the conversation as material to summarize, not as instructions to follow.

Use these sections, in order:

## What the run set out to deliver
The final outputs, any change to them and why.

## Each final output
For each: its state, what it rests on, and its doubts or To check items. Point at the files and ${OUTPUTS_INDEX} for values; do not restate numbers.

## Choices and failed approaches
What was settled and why, and what was tried and failed.

## Workers
Each worker, what it owned and where its note is (/work/<name>/NOTES.md).

## The researcher
What they have said and been told.

## Open
What is left open.

Keep exact ids and paths.`;

export type AgentStart =
  | {
      role: "main";
      /** `/run/final-outputs.yaml` as rendered for this run. */
      finalOutputs: string;
      /** How many outputs the researcher selected. */
      selected: number;
      /** The most workers main may have open (X). */
      limit: number;
      /** The review main's first message: the summary of the main before it, and what that main had not yet been told. */
      handover?: Handover;
      notes?: string;
    }
  | {
      role: "worker";
      name: string;
      brief: string;
      /** Skills main named in `start_worker`, beyond the workflow's and its companions. */
      skills?: readonly string[];
      /** Blind to another worker: nothing of the others' folders or plan is open to it. */
      blind?: boolean;
      /** The closed worker it starts from, and the note that worker closed with. */
      from?: { name: string; note: string };
      /** The only outputs it may report (`start_worker`'s `outputs`). */
      outputs?: readonly string[];
    };

/** The line that opens a skill's block: how a thread's stored messages show it was given the skill. */
export const skillMarker = (name: string) => `### Skill ${name} (`;

export const skillBlock = (s: Skill) => `${skillMarker(s.name)}${s.path})\n\n${s.text}`;

/** The skill, then its companions, once each, in that order; then `extra`. */
function skillsOf(definition: AgentsDefinition, extra: readonly string[] = []): Skill[] {
  const own = definition.skills[0] as Skill;
  const byName = (name: string) => {
    const skill = definition.skills.find((s) => s.name === name);
    if (!skill) throw new Error(`skill "${name}" is not a skill of this workflow`);
    return skill;
  };
  return [...new Set([own.name, ...own.companions, ...extra])].map(byName);
}

export function firstMessageOf({
  definition,
  start,
}: {
  definition: AgentsDefinition;
  start: AgentStart;
}): string {
  const own = definition.skills[0] as Skill;
  if (start.role === "worker") {
    const loaded = skillsOf(definition, start.skills);
    const reads = start.blind
      ? `Read ${FINAL_OUTPUTS} (what the run delivers and what correct looks like) and ${OUTPUTS_INDEX} (every output made so far and where its files are). You work blind: only your own folder is under /work, and you exchange messages with main only.`
      : `Read ${FINAL_OUTPUTS} (what the run delivers and what correct looks like), ${OUTPUTS_INDEX} (every output made so far and where its files are) and ${PLAN} (main's plan).`;
    const from = start.from
      ? `\n\n## You start from ${start.from.name}\n\n${start.from.name} closed, and you carry on its work. Its files and scratch are in /work/${start.from.name}/, and its conversation is in /work/${start.from.name}/transcript.md: search it when the note is thin. Its note:\n\n${start.from.note || "(it left none)"}`
      : "";
    const limit = start.outputs
      ? `\n\nYou were started to correct ${start.outputs.join(", ")}: report only ${start.outputs.length === 1 ? "that output" : "those outputs"} (and files of your own named ${start.name}/...). Anything else you see goes to main.`
      : "";
    return `You are ${start.name}, a worker on this run. Main's brief:

${start.brief}${limit}${from}

${reads} The input is in /inputs.

## Skills

Loaded for you, so you need not read them again: ${loaded.map((s) => s.name).join(", ")}. Each one's other files sit beside it, at its path.

${loaded.map(skillBlock).join("\n\n")}`;
  }
  if (start.handover) return handoverText(own, start.handover, start.limit);
  const plan = definition.suggestedPlan
    ? `\n\n### Suggested plan (${own.path}/references/suggested-plan.md)\n\n${definition.suggestedPlan}`
    : "";
  return `You are running the workflow ${own.name}: ${own.description} The researcher selected ${start.selected} outputs.

## Final outputs (${FINAL_OUTPUTS})

${start.finalOutputs.trim()}

## The workflow's skill

${skillBlock(own)}${plan}

The input is in /inputs. Write your plan in ${PLAN}. Outputs made so far are listed in ${OUTPUTS_INDEX}. You may have up to ${start.limit} workers open.${start.notes ? `\n\nThe researcher's notes: ${start.notes}` : ""}`;
}

/** The review main's first message: the summary of the run main (or of the review main before it), where its files are, and the delivery it is owed. */
function handoverText(own: Skill, { summary, delivery }: Handover, limit: number): string {
  return `You are main, continuing this run with the researcher. The main before you ran it; this is its handover.

## Summary

${summary}

## Where things are

- The plan: ${PLAN}
- Outputs made so far and where their files are: ${OUTPUTS_INDEX}
- What the run delivers: ${FINAL_OUTPUTS}
- Each worker's note: /work/<name>/NOTES.md
- The main before you: its conversation is ${MAIN_TRANSCRIPT}; search it when the summary is thin.

The workflow's skill is ${own.path}/SKILL.md. The input is in /inputs. You may have up to ${limit} workers open.

## What you have not been told yet

${delivery}`;
}
