/**
 * The prompts of a run's worker and check threads, built from the workflow's definition
 * (`@voluma/workflow`). A thread's system prompt is fixed for its life (a resumed thread
 * that differs fails), so it takes only what the pinned packages fix: the agent's
 * instructions, the workflow's intro, the skill list, and the runtime's own rules. What
 * varies by task goes in the thread's first message.
 */
import type { PlanTask } from "@voluma/harness/supervise-run";
import type { Agent, WorkflowDefinition } from "@voluma/workflow/definition";

const COMMON = `You work in a sandbox with one shell tool, bash. Python 3.12 with numpy, scipy, scikit-image, pydicom, nibabel, SimpleITK, matplotlib and pyvista (offscreen) is installed. There is no network.
/inputs holds the scan, /outputs/<task id>/ holds each task's result files, and /scratch is for temporary files.
Record your work with the task tools: checklist (task status), checkpoint (a milestone, with the files it rests on) and report_output (a result). Check what you report against the files themselves, and say which file or header each number came from. A file you name in an output or checkpoint is {root: "outputs", path} relative to /outputs/<task id>/, or {root: "scratch", path} relative to /scratch.`;

const WORKER = `You are an analysis agent working on one task of a micro-CT analysis run.\n${COMMON}
Set your task in-progress when you start. Report every required output with report_output. When all of them are reported set it done; set it to-check if you are unsure of something, and failed if it cannot be done. Work only on your own task.`;

const CHECK = `You are a second agent checking another agent's work on one task of a micro-CT analysis run.\n${COMMON}
Re-derive the task's results from the scan and the worker's files in /outputs/<task id>/ before you trust them. Write a checkpoint with verdict "passed" if you agree, or "needs-review" if you do not or cannot tell, with one plain line of why. You may fix a result with report_output; say so in the checkpoint. Check only your own task.`;

/**
 * The skills a role may use, progressively disclosed: name, description and path here, the
 * skill and its resources read with bash when needed. An agent that names none sees all.
 */
function skillList(def: WorkflowDefinition, agent: Agent | undefined): string {
  const named = new Set([...(agent?.load ?? []), ...(agent?.available ?? [])]);
  const skills = def.skills.filter((s) => named.size === 0 || named.has(s.name));
  if (skills.length === 0) return "";
  const first = new Set(agent?.load);
  const lines = skills.map(
    (s) =>
      `- ${s.name}: ${s.description} (${s.path}/SKILL.md)${first.has(s.name) ? " [read first]" : ""}`,
  );
  return `Skills: read a skill's SKILL.md with bash before you rely on it; its other files sit beside it in the same directory.\n${lines.join("\n")}`;
}

function system(def: WorkflowDefinition, agent: Agent | undefined, fallback: string): string {
  return [agent?.instructions, def.intro, skillList(def, agent), fallback]
    .filter((part): part is string => !!part)
    .join("\n\n");
}

export const workerSystem = (def: WorkflowDefinition) => system(def, def.roles.worker, WORKER);
export const checkSystem = (def: WorkflowDefinition) => system(def, def.roles.checker, CHECK);

function taskBrief(def: WorkflowDefinition, task: PlanTask): string {
  const prose = def.instructions[task.id];
  const done = task.doneWhen?.length
    ? `Done when:\n${task.doneWhen.map((d) => `- ${d}`).join("\n")}`
    : "";
  return [prose, done].filter(Boolean).join("\n\n");
}

export function workerPrompt(def: WorkflowDefinition, task: PlanTask): string {
  const needs = task.dependsOn.length
    ? `It builds on ${task.dependsOn.join(", ")}; their files are in /outputs/<task id>/.`
    : "It builds on no other task.";
  return `Your task is "${task.id}". ${needs}\n${taskBrief(def, task)}\n${outputList(task)}`;
}

export function checkPrompt(def: WorkflowDefinition, task: PlanTask): string {
  return `Check task "${task.id}". The worker's files are in /outputs/${task.id}/.\n${taskBrief(def, task)}\n${outputList(task)}`;
}

function outputList(task: PlanTask): string {
  if (task.outputs.length === 0) return "The task declares no outputs.";
  const lines = task.outputs.map((o) => `- ${JSON.stringify(o)}`);
  return `Declared outputs:\n${lines.join("\n")}`;
}
