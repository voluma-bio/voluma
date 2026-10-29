/**
 * Thread ids, built and read in one place. `<runId>.<taskId>.<role>` for a task's worker or
 * check thread, `<runId>.main` for the main agent, plus `.<n>` for the n-th (n > 1) of any of
 * them. Run and task ids hold no '.' (ids.ts), so the segments are unambiguous.
 */
import type { Role } from "./thread-log";

export const supervisorThreadId = (runId: string) => `${runId}.supervisor`;

export const threadId = (runId: string, taskId: string, role: Role, n: number) =>
  `${runId}.${taskId}.${role}${n === 1 ? "" : `.${n}`}`;

export const mainThreadId = (runId: string, n: number) => `${runId}.main${n === 1 ? "" : `.${n}`}`;

export type ParsedThread =
  /** `name`: the id without the run id, a thread's sandbox name and its folder under `/scratch`. */
  { name: string } & ({ kind: "main" } | { kind: Role; taskId: string });

/** Throws on an id that is not a worker, check or main thread of the run. */
export function parseThreadId(runId: string, id: string): ParsedThread {
  const name = id.startsWith(`${runId}.`) ? id.slice(runId.length + 1) : "";
  if (/^main(\.\d+)?$/.test(name)) return { name, kind: "main" };
  const task = /^([^.]+)\.(worker|check)(\.\d+)?$/.exec(name);
  if (task) return { name, kind: task[2] as Role, taskId: task[1] as string };
  throw new Error(`${id} is not a worker, check or main thread of run ${runId}`);
}
