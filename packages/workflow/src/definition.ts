/**
 * What a run takes from its workflow skill beyond the plan: the skills every role may read and
 * the data files the plan is built from.
 */
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { WorkflowFiles } from "@voluma/contracts/workflow-files";

export interface Skill {
  name: string;
  description: string;
  /** Where the sandbox mounts the skill's directory (`/workflow/...`). */
  path: string;
}

/** One script of a skill's `resources/`, with the first line of its docstring. */
export interface ToolIndexEntry {
  skill: string;
  /** The file name, e.g. `intake.py`. */
  script: string;
  summary: string;
}

/** Pi's thinking levels, `off` included; the check below fails the build if Pi adds one. */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const _complete: ModelThinkingLevel extends (typeof THINKING_LEVELS)[number] ? true : never = true;
void _complete;

/** One role file of `workflows/core/agents/`, read from the run's snapshot. */
export interface AgentDefinition {
  /** The file's name without `.md`. */
  name: string;
  description: string;
  /** An alias (`wonder`) the runner's config maps to a provider model. */
  model: string;
  /** The role's thinking level; unset: the runner's `RUNNER_THINKING`. */
  thinking?: ModelThinkingLevel;
  /** Every tool the role holds, base tools included (names in the harness's tool registry). */
  tools: string[];
  /**
   * Holding `bash` gives the role's threads a sandbox. `scratch` says what it writes: `own` (only
   * `/scratch/<name>/`; the rest of `/scratch` is read host-side) or `all` (all of `/scratch`).
   * Unset: `own`.
   */
  scratch: "own" | "all";
  /** The access to the run's `/outputs`, for the sandbox and host-side tools. Unset: `read`. */
  outputs: "read" | "write";
  /** The role that checks a task this role submits; each exists. Unset: its submissions are not checked. */
  checkedBy?: string;
  /** The roles this role may start; each exists. */
  subagents: string[];
  /** The skills named in the role's prompt: names of the workflow's `skills`, its own first. */
  skills: string[];
  /** The role's job: the file after its frontmatter, trimmed. */
  body: string;
}

export interface WorkflowDefinition {
  /** The workflow skill's directory, `workflows/<name>`. */
  dir: string;
  /** The commit of the checkout the snapshot was cut from (kept on a resume). */
  commit: string;
  /** Its `outputs.json` and `tasks.json`, validated together. */
  files: WorkflowFiles;
  /** The workflow's own skills first, then those of `workflows/core/skills/`. */
  skills: Skill[];
  /** Every skill's scripts, in `skills` order, each with its docstring's first line. */
  toolIndex: ToolIndexEntry[];
  /**
   * The role files of `workflows/core/agents/`, the same for every workflow. The loader requires
   * `main`, the role the run's first thread runs on.
   */
  agents: Record<string, AgentDefinition> & { main: AgentDefinition };
}

/** A file that could not be read into a definition; names where. */
export class WorkflowParseError extends Error {
  constructor(
    readonly file: string,
    message: string,
  ) {
    super(`${file}: ${message}`);
    this.name = "WorkflowParseError";
  }
}
