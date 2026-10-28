/**
 * The prompts of a run's worker and check threads, built from the claim's plan. A thread's
 * system prompt is fixed for its life (a resumed thread that differs fails), so it takes
 * nothing that varies by run. The plan carries a task's id, dependencies and declared
 * outputs and no description yet (`workflow.md` is not parsed), so that is all the prompt says.
 */
import type { PlanTask } from "@voluma/harness/task-runtime";

const COMMON = `You work in a sandbox with one shell tool, bash. Python 3.12 with numpy, scipy, scikit-image, pydicom, nibabel and SimpleITK is installed. There is no network.
/inputs holds the scan, /outputs/<task id>/ holds each task's result files, and /scratch is for temporary files.
Record your work with the task tools: checklist (task status), checkpoint (a milestone, with the files it rests on) and report_output (a result). Check what you report against the files themselves, and say which file or header each number came from. A file you name in an output or checkpoint is {root: "outputs", path} relative to /outputs/<task id>/, or {root: "scratch", path} relative to /scratch.`;

export const WORKER_SYSTEM = `You are an analysis agent working on one task of a micro-CT analysis run.\n${COMMON}
Set your task in-progress when you start. Report every required output with report_output. When all of them are reported set it done; set it to-check if you are unsure of something, and failed if it cannot be done. Work only on your own task.`;

export const CHECK_SYSTEM = `You are a second agent checking another agent's work on one task of a micro-CT analysis run.\n${COMMON}
Re-derive the task's results from the scan and the worker's files in /outputs/<task id>/ before you trust them. Write a checkpoint with verdict "passed" if you agree, or "needs-review" if you do not or cannot tell, with one plain line of why. You may fix a result with report_output; say so in the checkpoint. Check only your own task.`;

export function workerPrompt(task: PlanTask): string {
  const needs = task.dependsOn.length
    ? `It builds on ${task.dependsOn.join(", ")}; their files are in /outputs/<task id>/.`
    : "It builds on no other task.";
  return `Your task is "${task.id}". ${needs}\n${outputList(task)}`;
}

export function checkPrompt(task: PlanTask): string {
  return `Check task "${task.id}". The worker's files are in /outputs/${task.id}/.\n${outputList(task)}`;
}

function outputList(task: PlanTask): string {
  if (task.outputs.length === 0) return "The task declares no outputs.";
  const lines = task.outputs.map((o) => `- ${JSON.stringify(o)}`);
  return `Declared outputs:\n${lines.join("\n")}`;
}
