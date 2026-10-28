/**
 * What a run takes from its pinned packages beyond the plan: the prose the prompts are
 * built from, the agent assigned to each role, and the skills the agent may read. The
 * format is `workflow-md-format.md` in the docs repo (`work/mvp-contracts-and-data/design`).
 */
import type { WorkflowPlan } from "@voluma/contracts/workflow";

/** Roles a workflow may assign an agent definition to. `worker` is required. */
export const ROLES = ["worker", "checker", "main", "review"] as const;
export type Role = (typeof ROLES)[number];

export interface Agent {
  name: string;
  /** A model alias the host resolves, never a provider id. */
  model?: string;
  /** The agent file's body: the role's instructions. */
  instructions: string;
  /** Skills to read first, then skills listed for reading on demand (by name). */
  load: string[];
  available: string[];
  /** Harness tools beyond the always-on ones; the host rejects an unknown name. */
  tools: string[];
}

export interface Skill {
  name: string;
  description: string;
  /** Where the sandbox mounts the skill's directory (`/workflow/...`). */
  path: string;
}

export interface WorkflowDefinition {
  name: string;
  title: string;
  /** The prose before the first heading of `workflow.md`. */
  intro: string;
  plan: WorkflowPlan;
  /** Each task's prose from `workflow.md`, by task id. */
  instructions: Record<string, string>;
  /** Catalogs and the review template: parsed for shape, read by the review lane later. */
  parameters: unknown[];
  structures: unknown[];
  review: unknown;
  /** `worker` is always set; the parser refuses a workflow without it. */
  roles: Partial<Record<Role, Agent>> & { worker: Agent };
  /** Every skill in the run's pinned packages. */
  skills: Skill[];
}

/** A file that could not be read into a definition; names where. */
export class WorkflowParseError extends Error {
  constructor(
    readonly file: string,
    readonly where: string,
    message: string,
  ) {
    super(`${file}${where ? ` (${where})` : ""}: ${message}`);
    this.name = "WorkflowParseError";
  }
}
