/**
 * What a run takes from its workflow skill beyond the plan: the skills every role may read and
 * the data files the plan is built from. The format is `workflow-format.md` in the docs repo
 * (`work/mvp-contracts-and-data/design`).
 */
import type { WorkflowFiles } from "@voluma/contracts/workflow-files";

export interface Skill {
  name: string;
  description: string;
  /** Where the sandbox mounts the skill's directory (`/workflow/...`). */
  path: string;
}

/** One role file of `workflows/core/agents/`, read from the run's snapshot. */
export interface AgentDefinition {
  /** The file's name without `.md`. */
  name: string;
  description: string;
  /** The optional tools the role is granted (names in the harness's tool registry). */
  tools: string[];
  /** `planned`: nothing uses the role yet, so its tools are not checked against the registry. */
  planned: boolean;
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
  /**
   * The role files of `workflows/core/agents/`, the same for every workflow. A run starts the worker and
   * the checker, so the loader requires both; `others` holds the rest by name.
   */
  agents: {
    worker: AgentDefinition;
    checker: AgentDefinition;
    others: Record<string, AgentDefinition>;
  };
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
