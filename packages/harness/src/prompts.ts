/**
 * The agent loop's prompts. A thread's system prompt is fixed for its life: its role file, the
 * words and environment text every role shares, the mounts of its layout and the skill list. What
 * varies goes in its first message, built from the run's snapshot and the log, so a thread that
 * never stored its prompt rebuilds it identically. Everything here is generic: a workflow's
 * words come only from its skill, `outputs.yaml` and the notes it is handed.
 */
import type { AgentDefinition, Skill, WorkflowDefinition } from "@voluma/workflow/definition";
import type { ThreadLayout } from "./layout";

/** The paths every agent reads; the layout (`layout.ts`) and the run files writer make them true. */
const FINAL_OUTPUTS = "/run/final-outputs.yaml";
const OUTPUTS_INDEX = "/run/outputs.yaml";
const PLAN = "/work/main/plan.md";

export function systemPromptOf({
  definition,
  layout,
}: {
  definition: WorkflowDefinition;
  layout: ThreadLayout;
}): string {
  const role = definition.agents[layout.place];
  const skills = `${skillList(definition, role)}\n\n${toolIndex(definition, role)}`;
  return [role.body, definition.words, definition.environment, layout.description, skills].join(
    "\n\n",
  );
}

/** The tool a role reads files with: `read`, else its shell. */
const readerOf = (role: AgentDefinition) => (role.tools.includes("read") ? "`read`" : "bash");

/**
 * The role's skills, progressively disclosed: name, description and path here, the skill and its
 * references and resources read with the role's reading tool (`readerOf`) when needed. The
 * workflow's own skill comes first; its text is in the first message.
 */
function skillList(def: Pick<WorkflowDefinition, "skills">, role: AgentDefinition): string {
  const lines = def.skills
    .filter((s) => role.skills.includes(s.name))
    .map(
      (s) =>
        `- ${s.name}: ${s.description} (${s.path}/SKILL.md)${s === def.skills[0] ? " [in your first message]" : ""}`,
    );
  return `Skills: read a skill's SKILL.md with ${readerOf(role)} before you rely on it; its other files sit beside it in the same directory.\n${lines.join("\n")}`;
}

/** One line per script of the role's skills, from its docstring. */
function toolIndex(def: Pick<WorkflowDefinition, "toolIndex">, role: AgentDefinition): string {
  const lines = def.toolIndex
    .filter((t) => role.skills.includes(t.skill))
    .map((t) => `- ${t.skill}/${t.script}: ${t.summary}`);
  const use = role.tools.includes("bash")
    ? "Run `python <skill dir>/resources/<script> --help` before you use one."
    : `Workers run them; read one with ${readerOf(role)} to know what a worker's result rests on.`;
  return `Scripts of those skills, at <skill dir>/resources/<script> (skill dirs are listed above). ${use}\n${lines.join("\n")}`;
}

export type AgentStart =
  | {
      role: "main";
      /** `/run/final-outputs.yaml` as rendered for this run. */
      finalOutputs: string;
      /** How many outputs the researcher selected. */
      selected: number;
      /** The most workers main may have open (X). */
      limit: number;
      /** A replacement main in review: what it is told to take over (the run is under way, the researcher may be waiting). */
      takeover?: string;
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
function skillsOf(definition: WorkflowDefinition, extra: readonly string[] = []): Skill[] {
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
  definition: WorkflowDefinition;
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
  if (start.takeover !== undefined) return takeoverText(own, start.takeover, start.limit);
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

/**
 * A replacement main's first message, in review: the run is under way, so it reads what its
 * predecessor left rather than starting a plan. `news` is a delivery's text: the notices the
 * predecessor had not been told, the agents and what is out of date.
 */
function takeoverText(own: Skill, news: string, limit: number): string {
  return `You are taking over as main of a run of the workflow ${own.name} that is under way: the researcher is reviewing it, and the main before you stopped. Your plan is in ${PLAN}, the outputs made so far and where their files are in ${OUTPUTS_INDEX}, and what the run delivers in ${FINAL_OUTPUTS}; read them before you act. The workflow's skill is ${own.path}/SKILL.md. The input is in /inputs. You may have up to ${limit} workers open.

What you have not been told yet:

${news}`;
}
