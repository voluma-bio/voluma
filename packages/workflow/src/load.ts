/**
 * A run's view of its workflow: `loadWorkflow` snapshots `workflows/core/` and the run's workflow
 * directory (`workflows/<name>/`) from the runner's checkout into the run's R2 prefix when the
 * run starts (`workflowSnapshotPrefix`), and reads the snapshot, never the checkout, so a
 * resume after a redeploy that changed the files sees what the run began with. IO goes through
 * `WorkflowStore`, so this package holds no S3 client.
 *
 * Both directories hold skills, `skills/<name>/SKILL.md` with optional `references/` and
 * `resources/`. `core/` also holds the role files, `agents/<role>.md`, the same for every
 * workflow; the workflow's directory adds `outputs.json` and `tasks.json`. `core/convert/`
 * (the review converter, run by the runner's convert sandbox) is snapshotted too; nothing else
 * in either directory is.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { workflowFilesSchema } from "@voluma/contracts/workflow-files";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import {
  type AgentDefinition,
  type Skill,
  THINKING_LEVELS,
  type ToolIndexEntry,
  type WorkflowDefinition,
  WorkflowParseError,
} from "./definition";
import { docstringSummary } from "./docstring";

/** The run's snapshot bucket, as the loader needs it. Keys are R2 keys. */
export interface WorkflowStore {
  has(key: string): Promise<boolean>;
  put(key: string, body: Uint8Array): Promise<void>;
  /** Every key under `prefix`. */
  list(prefix: string): Promise<string[]>;
  get(key: string): Promise<string>;
}

export interface LoadOptions {
  store: WorkflowStore;
  /** The run's snapshot prefix (`workflowSnapshotPrefix(runId)`). */
  prefix: string;
  /** The checkout the workflows are read from: the repo root. */
  root: string;
  /** The commit that checkout is at, written into the snapshot's marker. */
  commit: string;
  /** The tool names a role may list (the harness's tool registry). */
  knownTools: readonly string[];
}

/** Every run's shared directory: the role files and the generic skills. */
const CORE = "workflows/core";

/** A workflow's directory, `workflows/<name>`: one lowercase segment, not `core`, not `.` or `..`. */
export const workflowDirSchema = z
  .string()
  .regex(/^workflows\/(?!\.+$)[a-z0-9._-]+$/)
  .refine((d) => d !== CORE, "core is not a workflow");

/** Keys of the Agent Skills format that Voluma does not read; any other key must be one it does. */
const SKILL_KEYS = ["license", "compatibility", "metadata", "allowed-tools", "type"] as const;
const frontmatterSchema = z.strictObject({
  name: z.string().min(1),
  description: z.string().min(1),
  ...Object.fromEntries(SKILL_KEYS.map((k) => [k, z.unknown().optional()])),
});

/** Where the role files live in the checkout and the snapshot; `AGENTS.md` there is for people. */
const AGENTS_DIR = `${CORE}/agents`;
const agentSchema = z.strictObject({
  name: z.string().min(1),
  description: z.string().min(1),
  model: z.string().min(1),
  thinking: z.enum(THINKING_LEVELS).optional(),
  tools: z.array(z.string().min(1)),
  subagents: z.array(z.string().min(1)).default([]),
  skills: z.array(z.string().min(1)).optional(),
});

/** Written last, so a snapshot cut short is redone, not trusted; its body is the commit. */
const DONE = ".snapshot-done";
const FILES = ["outputs.json", "tasks.json"];

/** Parses the `---` block against `schema`; `body` is what follows it, trimmed. */
function parseFile<T extends z.ZodType>(file: string, text: string, schema: T) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) throw new WorkflowParseError(file, "missing the --- frontmatter block");
  let data: unknown;
  try {
    data = parseYaml(m[1] ?? "");
  } catch (e) {
    throw new WorkflowParseError(file, `invalid frontmatter YAML: ${(e as Error).message}`);
  }
  const r = schema.safeParse(data ?? {});
  if (!r.success) {
    const issue = r.error.issues[0];
    throw new WorkflowParseError(
      file,
      `frontmatter ${issue?.path.join(".") || ""}: ${issue?.message}`.replace("  ", " "),
    );
  }
  return { data: r.data as z.output<T>, body: text.slice(m[0].length).trim() };
}

const frontmatter = (file: string, text: string) => parseFile(file, text, frontmatterSchema).data;

/** `skills` still unresolved: `parseAgent` leaves the default to the caller, who knows the skills. */
type ParsedAgent = Omit<AgentDefinition, "skills"> & { skills?: string[] };

function parseAgent(path: string, text: string, knownTools: readonly string[]): ParsedAgent {
  const { data, body } = parseFile(path, text, agentSchema);
  const name = path.slice(path.lastIndexOf("/") + 1, -".md".length);
  if (data.name !== name) {
    throw new WorkflowParseError(path, `name "${data.name}" must match its file name "${name}"`);
  }
  const unknown = data.tools.find((t) => !knownTools.includes(t));
  if (unknown) {
    throw new WorkflowParseError(path, `tool "${unknown}" is not a tool of the harness`);
  }
  if (!body) throw new WorkflowParseError(path, "the body is empty");
  return {
    name,
    description: data.description.replace(/\s+/g, " ").trim(),
    model: data.model,
    thinking: data.thinking,
    tools: data.tools,
    subagents: data.subagents,
    skills: data.skills,
    body,
  };
}

/**
 * A skill's script (`resources/*.py`, not a test, not `_`-prefixed): [skill, file name], else null.
 * Whether it is a script and not a library module is `isCli`'s call.
 */
function scriptOf(path: string): [string, string] | null {
  const m = /^workflows\/[^/]+\/skills\/([^/]+)\/resources\/([^/_][^/]*\.py)$/.exec(path);
  return m && !m[2]?.startsWith("test_") ? [m[1] as string, m[2] as string] : null;
}

/** A module with a `__main__` guard has a CLI to `--help`; one without is a library (`frame.py`). */
const isCli = (source: string) => /^if __name__ == ["']__main__["']/m.test(source);

/** Files under `rel`, minus dot-entries and `__pycache__` (git ignores them; a symlink is refused). */
async function* walk(root: string, rel: string): AsyncGenerator<string> {
  for (const entry of await readdir(join(root, rel), { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "__pycache__") continue;
    const path = `${rel}/${entry.name}`;
    if (entry.isSymbolicLink()) throw new WorkflowParseError(path, "symlinks are not supported");
    if (entry.isDirectory()) yield* walk(root, path);
    else if (entry.isFile()) yield path;
  }
}

async function snapshot(dir: string, { store, prefix, root, commit }: LoadOptions) {
  if (await store.has(`${prefix}${DONE}`)) return;
  const put = async (path: string) =>
    store.put(`${prefix}${path}`, await readFile(join(root, path)));
  for (const d of [CORE, dir]) {
    const names = await readdir(join(root, d)).catch(() => {
      throw new WorkflowParseError(d, "directory not found");
    });
    if (d === dir)
      for (const name of FILES.filter((f) => names.includes(f))) await put(`${d}/${name}`);
    if (names.includes("skills")) for await (const p of walk(root, `${d}/skills`)) await put(p);
    // The review converter (`core/convert/`), which the runner's convert sandbox runs from /workflow.
    if (d === CORE && names.includes("convert"))
      for await (const p of walk(root, `${d}/convert`)) await put(p);
  }
  for (const name of await readdir(join(root, AGENTS_DIR)).catch(() => {
    throw new WorkflowParseError(AGENTS_DIR, "directory not found");
  })) {
    if (name.endsWith(".md") && name !== "AGENTS.md") await put(`${AGENTS_DIR}/${name}`);
  }
  await store.put(`${prefix}${DONE}`, new TextEncoder().encode(commit));
}

/** Snapshots `dir` (`workflows/<name>`) unless the run already has one, then reads the snapshot. */
export async function loadWorkflow(dir: string, options: LoadOptions): Promise<WorkflowDefinition> {
  workflowDirSchema.parse(dir);
  await snapshot(dir, options);
  const { store, prefix } = options;
  const texts = new Map<string, string>();
  for (const key of await store.list(prefix)) {
    const path = key.slice(prefix.length);
    if (
      /(^|\/)SKILL\.md$|(^|\/)(outputs|tasks)\.json$|^workflows\/core\/agents\/[^/]+\.md$/.test(
        path,
      ) ||
      scriptOf(path)
    )
      texts.set(path, await store.get(key));
  }

  // A snapshot cut before `checker.md` became `check.md` (R2 snapshots are write-once): refused
  // before its role files parse, since an old one may not match the current format.
  if (texts.has(`${AGENTS_DIR}/checker.md`) && !texts.has(`${AGENTS_DIR}/check.md`))
    throw new Error(
      "This run was made by an older version of Voluma and can't be resumed; start a new run.",
    );

  // The workflow's own skill (named for its directory) first, then its others, then core's, each
  // group sorted: the order must not depend on how the store lists keys.
  const own = `${dir}/skills/${dir.slice(dir.lastIndexOf("/") + 1)}/SKILL.md`;
  if (!texts.has(own))
    throw new WorkflowParseError(
      own,
      "not found: a workflow needs a skill named for its directory",
    );
  const skillPaths = (d: string) =>
    [...texts.keys()]
      .filter(
        (p) => p.startsWith(`${d}/skills/`) && /^[^/]+\/SKILL\.md$/.test(p.slice(d.length + 8)),
      )
      .sort();
  const skills: Skill[] = [];
  for (const path of [own, ...skillPaths(dir).filter((p) => p !== own), ...skillPaths(CORE)]) {
    const text = texts.get(path) as string;
    const skillDir = path.slice(0, -"/SKILL.md".length);
    const fm = frontmatter(path, text);
    const expected = skillDir.slice(skillDir.lastIndexOf("/") + 1);
    if (fm.name !== expected) {
      throw new WorkflowParseError(
        path,
        `name "${fm.name}" must match its directory "${expected}"`,
      );
    }
    if (skills.some((s) => s.name === fm.name)) {
      throw new WorkflowParseError(path, `skill "${fm.name}" is defined twice`);
    }
    skills.push({
      name: fm.name,
      description: fm.description.replace(/\s+/g, " ").trim(),
      path: `/workflow/${skillDir}`,
    });
  }

  const json = (name: string) => {
    const text = texts.get(`${dir}/${name}`);
    if (text === undefined) throw new WorkflowParseError(`${dir}/${name}`, "not found");
    try {
      return JSON.parse(text) as unknown;
    } catch (e) {
      throw new WorkflowParseError(`${dir}/${name}`, `invalid JSON: ${(e as Error).message}`);
    }
  };
  const files = workflowFilesSchema.safeParse({
    outputs: json("outputs.json"),
    tasks: json("tasks.json"),
  });
  if (!files.success) {
    const issue = files.error.issues[0];
    const file = issue?.path[0] === "tasks" ? "tasks.json" : "outputs.json";
    throw new WorkflowParseError(
      `${dir}/${file}`,
      `${issue?.path.slice(1).join(".")}: ${issue?.message}`,
    );
  }

  const toolIndex: ToolIndexEntry[] = [];
  for (const skill of skills) {
    const scripts = [...texts.keys()].filter((p) =>
      p.startsWith(`${skill.path.slice("/workflow/".length)}/resources/`),
    );
    for (const path of scripts.sort()) {
      const script = scriptOf(path)?.[1];
      const source = texts.get(path) as string;
      if (!script || !isCli(source)) continue;
      toolIndex.push({
        skill: skill.name,
        script,
        summary: docstringSummary(path, source),
      });
    }
  }

  const found: Record<string, ParsedAgent> = {};
  for (const [path, text] of texts) {
    if (!path.startsWith(`${AGENTS_DIR}/`)) continue;
    const agent = parseAgent(path, text, options.knownTools);
    found[agent.name] = agent;
  }
  const skillNames = skills.map((s) => s.name);
  const agents: Record<string, AgentDefinition> = {};
  for (const agent of Object.values(found)) {
    const path = `${AGENTS_DIR}/${agent.name}.md`;
    const missing = agent.subagents.find((n) => !found[n]);
    if (missing) throw new WorkflowParseError(path, `subagent "${missing}" is not a role file`);
    if (agent.tools.includes("start_worker") && !agent.subagents.includes("worker")) {
      throw new WorkflowParseError(
        path,
        `a role with start_worker lists "worker" in its subagents`,
      );
    }
    const unknown = agent.skills?.find((n) => !skillNames.includes(n));
    if (unknown)
      throw new WorkflowParseError(path, `skill "${unknown}" is not a skill of this workflow`);
    agents[agent.name] = { ...agent, skills: agent.skills ?? skillNames };
  }
  const { main, worker, check } = agents;
  for (const [name, role] of Object.entries({ main, worker, check })) {
    if (!role) throw new WorkflowParseError(`${prefix}${AGENTS_DIR}/${name}.md`, "not found");
  }
  return {
    dir,
    commit: await store.get(`${prefix}${DONE}`),
    files: files.data,
    skills,
    toolIndex,
    agents: {
      main: main as AgentDefinition,
      worker: worker as AgentDefinition,
      check: check as AgentDefinition,
    },
  };
}
