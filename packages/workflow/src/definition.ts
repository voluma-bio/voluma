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

export interface WorkflowDefinition {
  /** The workflow skill's directory, `workflows/workflow-<name>`. */
  dir: string;
  /** Its `outputs.json` and `tasks.json`, validated together. */
  files: WorkflowFiles;
  /** The workflow's own skill first, then the skills of each directory it `uses`. */
  skills: Skill[];
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
