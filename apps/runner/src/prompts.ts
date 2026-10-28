/**
 * The prompts of a run's worker and check threads: the harness's role prompts plus the
 * workflow's skills and task text (`@voluma/workflow`). A thread's system prompt is fixed for
 * its life (a resumed thread that differs fails), so it takes only the role's rules and the
 * skill list, both fixed by the run's snapshot. What varies by task goes in the thread's
 * first message.
 */
import type { PlanTask } from "@voluma/harness/supervise-run";
import type { WorkflowDefinition } from "@voluma/workflow/definition";

const COMMON = `You work in a sandbox with one shell tool, bash. Python 3.12 with numpy, scipy, scikit-image, pydicom, nibabel, SimpleITK, matplotlib and pyvista (offscreen) is installed. There is no network.
/inputs holds the scan, /outputs/<task id>/ holds each task's result files, and /scratch is for temporary files.
Record your work with the task tools: checklist (task status), checkpoint (a milestone, with the files it rests on) and report_output (a result). Check what you report against the files themselves, and say which file or header each number came from. A file you name in an output or checkpoint is {root: "outputs", path} relative to /outputs/<task id>/, or {root: "scratch", path} relative to /scratch.`;

const WORKER = `You are an analysis agent working on one task of a micro-CT analysis run.\n${COMMON}
Set your task in-progress when you start. Report every required output with report_output. When all of them are reported set it done; set it to-check if you are unsure of something, and failed if it cannot be done. Work only on your own task.`;

const CHECK = `You are a second agent checking another agent's work on one task of a micro-CT analysis run.\n${COMMON}
Re-derive the task's results from the scan and the worker's files in /outputs/<task id>/ before you trust them. Write a checkpoint with verdict "passed" if you agree, or "needs-review" if you do not or cannot tell, with one plain line of why. You may fix a result with report_output; say so in the checkpoint. Check only your own task.`;

/**
 * The skills every role may use, progressively disclosed: name, description and path here, the
 * skill and its references and resources read with bash when needed. The workflow's own skill
 * comes first and is read first.
 */
function skillList(def: WorkflowDefinition): string {
  const lines = def.skills.map(
    (s, i) => `- ${s.name}: ${s.description} (${s.path}/SKILL.md)${i === 0 ? " [read first]" : ""}`,
  );
  return `Skills: read a skill's SKILL.md with bash before you rely on it; its other files sit beside it in the same directory.\n${lines.join("\n")}`;
}

export const workerSystem = (def: WorkflowDefinition) => `${WORKER}\n\n${skillList(def)}`;
export const checkSystem = (def: WorkflowDefinition) => `${CHECK}\n\n${skillList(def)}`;

function taskBrief(task: PlanTask): string {
  const { instructions } = task;
  const done = task.doneWhen?.length
    ? `Done when:\n${task.doneWhen.map((d) => `- ${d}`).join("\n")}`
    : "";
  return [instructions, done].filter(Boolean).join("\n\n");
}

/** What a thread's first message carries besides its task: the run's notes, then the main thread's. */
export interface Notes {
  /** The user's notes for the run, verbatim. */
  user?: string;
  /** The main thread's notes in force when the thread starts. */
  main?: string;
}

const PRECEDENCE =
  "The task's done-when criteria and required outputs come first; notes never outrank them.";

function notesBlock({ user, main }: Notes, role: "worker" | "check"): string {
  const parts = [];
  if (user) parts.push(`The user's notes for this run:\n${user}`);
  if (main) {
    parts.push(
      role === "worker"
        ? `Notes from the main thread, from the tasks before this one. Build on what they settle; if you find one is wrong, say so.\n${main}`
        : `Context from the main thread, from the tasks before this one. Your verdict rests on your own re-derivation of the result, not on these notes.\n${main}`,
    );
  }
  return parts.length ? `\n${PRECEDENCE}\n${parts.join("\n")}` : "";
}

export function workerPrompt(task: PlanTask, notes: Notes): string {
  const needs = task.dependsOn.length
    ? `It builds on ${task.dependsOn.join(", ")}; their files are in /outputs/<task id>/.`
    : "It builds on no other task.";
  return `Your task is "${task.id}". ${needs}\n${taskBrief(task)}\n${outputList(task)}${notesBlock(notes, "worker")}`;
}

export function checkPrompt(task: PlanTask, notes: Notes): string {
  return `Check task "${task.id}". The worker's files are in /outputs/${task.id}/.\n${taskBrief(task)}\n${outputList(task)}${notesBlock(notes, "check")}`;
}

function outputList(task: PlanTask): string {
  if (task.outputs.length === 0) return "The task declares no outputs.";
  const lines = task.outputs.map((o) => `- ${JSON.stringify(o)}`);
  return `Declared outputs:\n${lines.join("\n")}`;
}
