/**
 * What a run takes from its workflow snapshot: the role files, the skills every role may read and
 * the output catalog.
 */
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { OutputCatalog } from "@voluma/contracts/output-catalog";

export interface Skill {
  name: string;
  description: string;
  /** Where the sandbox mounts the skill's directory (`/workflow/...`). */
  path: string;
  /** The `SKILL.md` after its frontmatter: what a first message carries. */
  text: string;
  /** Skills that always load beside this one (frontmatter `companions:`). */
  companions: string[];
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
  /** The role's thinking level; unset: none is requested (a run's own `thinking` wins). */
  thinking?: ModelThinkingLevel;
  /** Every tool the role holds, base tools included (names in `AGENT_TOOL_NAMES`, `harness/tools/registry.ts`). */
  tools: string[];
  /** The skills named in the role's prompt: names of the workflow's `skills`, its own first. */
  skills: string[];
  /** The role's job: the file after its frontmatter, trimmed. */
  body: string;
}

/** What a run reads from its workflow snapshot. */
export interface WorkflowDefinition {
  /** The workflow skill's directory, `workflows/<name>`. */
  dir: string;
  /** The commit of the checkout the snapshot was cut from (kept on a resume). */
  commit: string;
  /** The workflow's own skills first, then those of `workflows/core/skills/`. */
  skills: Skill[];
  /** Every skill's scripts, in `skills` order, each with its docstring's first line. */
  toolIndex: ToolIndexEntry[];
  /**
   * The role files of `workflows/core/agents/`, the same for every workflow: `main` is the role
   * the run's first thread runs on, `worker` the role of the threads it starts.
   */
  agents: { main: AgentDefinition; worker: AgentDefinition };
  /** Its `outputs.yaml`, validated. */
  outputCatalog: OutputCatalog;
  /** The workflow skill's `references/suggested-plan.md`, when it has one: main's first message carries it. */
  suggestedPlan?: string;
  /** `agents/words.md`: the words the researcher reads, appended to every role's system prompt. */
  words: string;
  /** `agents/environment.md`: what the sandbox is, appended to every role's system prompt. */
  environment: string;
  /**
   * `core/review.md`: appended to the review main's system prompt (`packages/harness/src/prompts.ts`). Absent in
   * a snapshot cut before it existed.
   */
  review?: string;
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

/** Why a run made by an earlier version is refused: by the snapshot loader and the runner's claim. */
export const OLDER_VERSION_MESSAGE =
  "This run was made by an older version of Voluma and can't be resumed; start a new run.";
