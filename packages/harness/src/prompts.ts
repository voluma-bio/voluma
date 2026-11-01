/**
 * The prompts of a run's threads: the role files plus the sandbox text and the workflow's
 * skills (`@voluma/workflow`) as system prompts, and each role's first message. The role's own
 * text is its file in `workflows/core/agents/`, from the run's snapshot. A thread's system
 * prompt is fixed for its life (a resumed thread that differs fails), so it takes only the
 * role's rules and the skill list, both fixed by the run's snapshot. What varies goes in the
 * first message, which gives each role what its role file says it gets: main the plan, the
 * deliverable and the researcher's notes; a worker its task, the plan, the deliverable, the main
 * agent's brief and the notes; a checker the task as planned, what the worker reported and the evidence it cited,
 * never the worker's account.
 */
import type { Folded, FoldedTask } from "@voluma/contracts/fold";
import type { WorkflowFiles } from "@voluma/contracts/workflow-files";
import type { AgentDefinition, WorkflowDefinition } from "@voluma/workflow/definition";
import type { ThreadLayout } from "./layout";
import type { PlanTask } from "./task-runtime";

function common(thread: ThreadLayout): string {
  const dir = thread.dir;
  const files = !thread.reviewer
    ? `/outputs/<task id>/ holds each task's result files, and ${dir}/ is your own folder for intermediate files (the other threads' folders are beside it under /scratch); both are kept if the sandbox restarts. /outputs and /scratch are network-backed mounts`
    : `/outputs/<task id>/ holds the worker's result files (read-only), and ${dir}/ is your own folder for intermediate files, kept if the sandbox restarts; the rest of /scratch is not available to your shell, and view_image opens only the scratch files the worker cited as evidence. ${dir} is a network-backed mount`;
  return `You work in a sandbox with one shell tool, bash. Python 3.12 with numpy, scipy, scikit-image, pydicom, nibabel, SimpleITK, matplotlib and pyvista (offscreen) is installed. There is no network.
/inputs holds the scan (${thread.copiesInputs ? "a local copy" : "read-only, read from the bucket, not copied"}), ${files}: write each file whole, once. They do not support rename within them (\`sed -i\`, editors), append (\`>>\`), in-place edits or memory-mapped writes (\`np.lib.format.open_memmap\` in write mode, \`np.memmap\`). Build a file under /tmp (local disk, lost on restart), then \`cp\` it in.
Commands start in $SCRATCH (${dir}): write your working files under $SCRATCH, and cite one as {root: "scratch", path: <path inside $SCRATCH>}.
Check what you report against the files themselves, and say which file or header each number came from. Record your work with the task tools. Name a file in an output or checkpoint as {root: "scratch", path: <path inside $SCRATCH>} for your working folder, or {root: "outputs", path: <path inside /outputs/<task id>/>} for a task's result file${thread.reviewer ? " you inspected" : ""}.`;
}

/**
 * The role's skills, progressively disclosed: name, description and path here, the skill and its
 * references and resources read with `read` when
 * needed. The workflow's own skill comes first and is read first.
 */
function skillList(def: WorkflowDefinition, role: AgentDefinition): string {
  const lines = def.skills
    .filter((s) => role.skills.includes(s.name))
    .map(
      (s) =>
        `- ${s.name}: ${s.description} (${s.path}/SKILL.md)${s === def.skills[0] ? " [read first]" : ""}`,
    );
  return `Skills: read a skill's SKILL.md with \`read\` before you rely on it; its other files sit beside it in the same directory.\n${lines.join("\n")}`;
}

/** One line per script of the role's skills, from its docstring. */
function toolIndex(def: WorkflowDefinition, role: AgentDefinition, shell: boolean): string {
  const lines = def.toolIndex
    .filter((t) => role.skills.includes(t.skill))
    .map((t) => `- ${t.skill}/${t.script}: ${t.summary}`);
  const use = shell
    ? "Run `python <skill dir>/resources/<script> --help` before you use one."
    : "Workers run them; read one with `read` to know what a worker's result rests on.";
  return `Scripts of those skills, at <skill dir>/resources/<script> (skill dirs are listed above). ${use}\n${lines.join("\n")}`;
}

/** The role file's body, then the generated environment text, skill list and tool index. */
export function systemPrompt(def: WorkflowDefinition, thread: ThreadLayout): string {
  const role = def.agents[thread.role];
  if (!role) throw new Error(`${thread.name} runs on ${thread.role}, which is not a role file`);
  const shell = role.tools.includes("bash");
  const skills = `${skillList(def, role)}\n\n${toolIndex(def, role, shell)}`;
  if (!shell) return `${role.body}\n\n${skills}`;
  return `${role.body}\n\n${common(thread)}\n\n${skills}`;
}

function taskBrief(task: PlanTask): string {
  const { instructions } = task;
  const done = task.doneWhen?.length
    ? `Done when:\n${task.doneWhen.map((d) => `- ${d}`).join("\n")}`
    : "";
  return [instructions, done].filter(Boolean).join("\n\n");
}

function outputList(task: PlanTask): string {
  if (task.outputs.length === 0) return "The task declares no outputs.";
  const lines = task.outputs.map((o) => `- ${JSON.stringify(o)}`);
  return `Declared outputs:\n${lines.join("\n")}`;
}

/** The researcher's notes, as a worker or the main agent reads them. */
function notesBlock(notes: string | undefined): string {
  return notes
    ? `\n\nThe researcher's notes for this run (the task's done-when criteria and required outputs come first; notes never outrank them):\n${notes}`
    : "";
}

/**
 * A worker's first message: its task in full, the whole plan with its own task marked and the
 * deliverable (so it knows who uses its outputs), then the main agent's brief and the notes.
 */
export function workerPrompt(
  task: PlanTask,
  brief: string,
  view: Folded,
  selected: readonly string[] | undefined,
  workflow: WorkflowFiles,
  notes: string | undefined,
): string {
  const needs = task.dependsOn.length
    ? `It builds on ${task.dependsOn.join(", ")}; their files are in /outputs/<task id>/.`
    : "It builds on no other task.";
  return `Your task is "${task.id}". ${needs}\n${taskBrief(task)}\n${outputList(task)}\n\n${planBlock(view, workflow, { id: task.id, reader: "worker" })}\n\n${deliverableBlock(selected, workflow)}\n\nFrom the main agent:\n${brief}${notesBlock(notes)}`;
}

const list = (items: string[]) => (items.length ? items.join("\n") : "(none)");

/**
 * The check thread's first message: the task as planned, each output the worker reported with
 * its value, and the evidence files it cited, then the plan, the deliverable and the researcher's
 * notes. Never the brief, a checkpoint's text, the worker's messages or its notes on a value (only the reason a value is missing).
 */
export function checkPrompt(
  task: PlanTask,
  state: FoldedTask,
  view: Folded,
  selected: readonly string[] | undefined,
  workflow: WorkflowFiles,
  notes: string | undefined,
): string {
  const evidenceName = new Map(state.evidence.map((a) => [a.id, a.name]));
  const evidenceOf = (ids: string[]) => {
    const names = ids.flatMap((id) => evidenceName.get(id) ?? []);
    return names.length ? `; evidence: ${names.join(", ")}` : "";
  };
  // The worker's free note is its own account; only the reason a value is missing is a fact.
  const why = (n: string | undefined) => (n ? `; reason given: ${n}` : "");
  const reported = [
    ...state.measurements.map(
      (m) =>
        `- ${m.id}: ${m.value === null ? "no value" : `${m.value} ${m.unit}`}${m.confidence ? ` (${m.confidence})` : ""}${m.value === null ? why(m.note) : ""}${evidenceOf(m.evidenceIds)}`,
    ),
    ...state.scores.map(
      (c) =>
        `- ${c.id}: level "${c.level}"${c.scale ? ` of ${c.scale.join(" < ")}` : ""}${evidenceOf(c.evidenceIds)}`,
    ),
    ...state.files.map((f) => `- ${f.id}: file ${f.name}`),
    ...state.missing.flatMap((m) =>
      m.reason ? [`- ${m.outputId}: reported missing, because: ${m.reason}`] : [],
    ),
  ];
  const cited = [
    ...state.evidence.flatMap((a) =>
      state.citedScratch.includes(a.name) ? [] : [`- {root: "outputs", path: "${a.name}"}`],
    ),
    ...state.citedScratch.map((p) => `- {root: "scratch", path: "${p}"}`),
  ];
  return `Check task "${task.id}". The worker's files are in /outputs/${task.id}/.
${taskBrief(task)}
${outputList(task)}

Outputs the worker reported (other structures, volumes and annotations are in its files):
${list(reported)}

Evidence files the worker cited (open them with view_image):
${list(cited)}

${planBlock(view, workflow, { id: task.id, reader: "check" })}

${deliverableBlock(selected, workflow)}${notesBlock(notes)}`;
}

/**
 * The plan as the main agent or a worker reads it: each task with what it builds on, what it does
 * and the outputs it reports. For a worker or a check, `own` is its task, which its message already
 * gives in full.
 */
function planBlock(
  view: Folded,
  workflow: WorkflowFiles,
  own?: { id: string; reader: "worker" | "check" },
): string {
  const names = new Map(workflow.outputs.map((o) => [o.id, o.name]));
  const intro =
    own?.reader === "worker"
      ? "Every task of the run, so you know what builds on yours and who uses your outputs. The main agent can change it; if it changes your task or the plan while you work, you are told.\n\n"
      : own
        ? "Every task of the run, so you can judge whether this task's outputs serve the tasks that build on it.\n\n"
        : "";
  const tasks = view.plan.tasks.map((t) => {
    if (t.id === own?.id)
      return `### ${t.id}${t.title ? ` (${t.title})` : ""} (${own.reader === "worker" ? "your task" : "the task you check"}, in full above)`;
    const outputs = t.outputs.map(
      (o) =>
        `  - ${o.id}${names.has(o.id) ? ` (${names.get(o.id)})` : ""}: ${o.kind}${o.required ? ", required" : ""}`,
    );
    return `### ${t.id}${t.title ? ` (${t.title})` : ""}
Builds on: ${t.dependsOn.length ? t.dependsOn.join(", ") : "nothing"}
${taskBrief(t)}
Reports:
${outputs.length ? outputs.join("\n") : "  (no outputs)"}`;
  });
  return `## The plan\n\n${intro}${tasks.join("\n\n")}`;
}

/** The outputs the researcher selected: what the run is for. */
function deliverableBlock(
  selected: readonly string[] | undefined,
  workflow: WorkflowFiles,
): string {
  const names = new Map(workflow.outputs.map((o) => [o.id, o.name]));
  const ids = selected ?? workflow.outputs.map((o) => o.id);
  const lines = ids.map((id) => `- ${id}${names.has(id) ? ` (${names.get(id)})` : ""}`);
  return `## The deliverable\n\n${selected ? "The researcher selected these outputs" : "The researcher selected every output of the workflow"}; the run is done when each is reported with its evidence, or missing with a reason:\n${lines.join("\n")}`;
}

/** The main agent's first message: the plan, the deliverable, the researcher's notes. */
export function mainPrompt(
  view: Folded,
  selected: readonly string[] | undefined,
  workflow: WorkflowFiles,
  notes: string | undefined,
): string {
  return `${planBlock(view, workflow)}\n\n${deliverableBlock(selected, workflow)}${notesBlock(notes)}`;
}

/** `main.<n>`'s first message: what the old thread was doing is gone, so the log's state comes with the plan. */
export function mainRestartPrompt(
  view: Folded,
  state: string,
  selected: readonly string[] | undefined,
  workflow: WorkflowFiles,
  notes: string | undefined,
): string {
  return `The main agent before you is gone, and whatever it had in mind went with it: start from the record, and trust the lists below over anything you assume.\n\n## The state of the run\n\n${state}\n\n${planBlock(view, workflow)}\n\n${deliverableBlock(selected, workflow)}${notesBlock(notes)}`;
}
