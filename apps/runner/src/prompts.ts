/**
 * The prompts of a run's worker and check threads: the role files plus the sandbox text and the
 * workflow's skills and task text (`@voluma/workflow`). The role's own text is its file in
 * `workflows/core/agents/`, from the run's snapshot. A thread's system prompt is fixed for
 * its life (a resumed thread that differs fails), so it takes only the role's rules and the
 * skill list, both fixed by the run's snapshot. What varies by task goes in the thread's
 * first message.
 */
import type { ThreadLayout } from "@voluma/harness/layout";
import type { PlanTask } from "@voluma/harness/supervise-run";
import type { WorkflowDefinition } from "@voluma/workflow/definition";

function common(role: Exclude<ThreadLayout["role"], "main">, thread: ThreadLayout): string {
  const dir = thread.dir;
  const files =
    role === "worker"
      ? `/outputs/<task id>/ holds each task's result files, and ${dir}/ is your own folder for intermediate files (the other threads' folders are beside it under /scratch); both are kept if the sandbox restarts. /outputs and /scratch are network-backed mounts`
      : `/outputs/<task id>/ holds the worker's result files (read-only), and ${dir}/ is your own folder for intermediate files, kept if the sandbox restarts; the rest of /scratch is not available to your shell, and view_image opens only the scratch files the worker cited as evidence. ${dir} is a network-backed mount`;
  const evidence =
    role === "worker"
      ? `{root: "outputs", path} relative to /outputs/<task id>/, or {root: "scratch", path} relative to /scratch (a file ${dir}/x.png is "${thread.name}/x.png")`
      : `{root: "scratch", path} relative to /scratch (a file ${dir}/x.png is "${thread.name}/x.png"), or {root: "outputs", path} relative to /outputs/<task id>/ for a worker's file you inspected`;
  return `You work in a sandbox with one shell tool, bash. Python 3.12 with numpy, scipy, scikit-image, pydicom, nibabel, SimpleITK, matplotlib and pyvista (offscreen) is installed. There is no network.
/inputs holds the scan (a local copy), ${files}: write each file whole, once. They do not support rename within them (\`sed -i\`, editors), append (\`>>\`), in-place edits or memory-mapped writes (\`np.lib.format.open_memmap\` in write mode, \`np.memmap\`). Build a file under /tmp (local disk, lost on restart), then \`cp\` it in.
Commands start in $SCRATCH (${dir}): write your working files under $SCRATCH, and cite one as {root: "scratch", path: <the part after /scratch/>}.
Check what you report against the files themselves, and say which file or header each number came from. Record your work with the task tools. A file you name in an output or checkpoint is ${evidence}.`;
}

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

/** The role file's body, then the generated environment text and skill list. */
export function systemPrompt(
  def: WorkflowDefinition,
  role: "worker" | "checker",
  thread: ThreadLayout,
): string {
  return `${def.agents[role].body}\n\n${common(role, thread)}\n\n${skillList(def)}`;
}

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
