/**
 * A run's view of its workflow skill: `loadWorkflow` snapshots the workflow's directory and
 * the skill directories it `uses` from the runner's checkout into the run's R2 prefix when the
 * run starts (`workflowSnapshotPrefix`), and reads the snapshot, never the checkout, so a
 * resume after a redeploy that changed the files sees what the run began with. IO goes through
 * `WorkflowStore`, so this package holds no S3 client.
 *
 * A skill directory holds `SKILL.md` and may hold `references/` and `resources/`; a directory
 * may also hold skills one level down, `skills/<name>/`. The workflow's directory adds
 * `outputs.json` and `tasks.json`. The role files of `workflows/agents/` are snapshotted too: they
 * are the same for every workflow.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { workflowFilesSchema } from "@voluma/contracts/workflow-files";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import {
  type AgentDefinition,
  type Skill,
  type WorkflowDefinition,
  WorkflowParseError,
} from "./definition";

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
  /** The optional tool names a role may list (the harness's tool registry). */
  knownTools: readonly string[];
}

/** A directory of the repo under `workflows/`: lowercase segments, no `.` or `..`. */
export const workflowDirSchema = z
  .string()
  .regex(/^workflows\/[a-z0-9._-]+(\/[a-z0-9._-]+)*$/)
  .refine((d) => !d.split("/").some((p) => /^\.+$/.test(p)), "must not contain . or ..");

/** Keys of the Agent Skills format that Voluma does not read; any other key must be one it does. */
const SKILL_KEYS = ["license", "compatibility", "metadata", "allowed-tools", "type"] as const;
const frontmatterSchema = z.strictObject({
  name: z.string().min(1),
  description: z.string().min(1),
  /** Other skill directories this skill's roles may use (the workflow's own skill only). */
  uses: z.array(workflowDirSchema).default([]),
  ...Object.fromEntries(SKILL_KEYS.map((k) => [k, z.unknown().optional()])),
});

/** Where the role files live in the checkout and the snapshot; `AGENTS.md` there is for people. */
const AGENTS_DIR = "workflows/agents";
const agentSchema = z.strictObject({
  name: z.string().min(1),
  description: z.string().min(1),
  tools: z.array(z.string().min(1)),
  status: z.literal("planned").optional(),
});

/** Written last, so a snapshot cut short is redone, not trusted; its body is the commit. */
const DONE = ".snapshot-done";
const FILES = ["SKILL.md", "outputs.json", "tasks.json"];
const TREES = ["references", "resources", "skills"];

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

function parseAgent(path: string, text: string, knownTools: readonly string[]): AgentDefinition {
  const { data, body } = parseFile(path, text, agentSchema);
  const name = path.slice(path.lastIndexOf("/") + 1, -".md".length);
  if (data.name !== name) {
    throw new WorkflowParseError(path, `name "${data.name}" must match its file name "${name}"`);
  }
  const planned = data.status === "planned";
  const unknown = data.tools.find((t) => !knownTools.includes(t));
  if (!planned && unknown) {
    throw new WorkflowParseError(path, `tool "${unknown}" is not an optional tool of the harness`);
  }
  if (!body) throw new WorkflowParseError(path, "the body is empty");
  return {
    name,
    description: data.description.replace(/\s+/g, " ").trim(),
    tools: data.tools,
    planned,
    body,
  };
}

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

/** The directories the workflow's `SKILL.md` lists in `uses`, read from the checkout. */
async function usedDirs(root: string, dir: string): Promise<string[]> {
  const file = `${dir}/SKILL.md`;
  const text = await readFile(join(root, file), "utf8").catch(() => {
    throw new WorkflowParseError(file, "not found");
  });
  return frontmatter(file, text).uses;
}

async function snapshot(dir: string, { store, prefix, root, commit }: LoadOptions) {
  if (await store.has(`${prefix}${DONE}`)) return;
  const dirs = [dir, ...(await usedDirs(root, dir))];
  for (const d of dirs) {
    const names = await readdir(join(root, d)).catch(() => {
      throw new WorkflowParseError(d, "directory not found");
    });
    const paths: string[] = [];
    for (const name of names) {
      if (FILES.includes(name) && (d === dir || name === "SKILL.md")) paths.push(`${d}/${name}`);
      if (TREES.includes(name)) for await (const p of walk(root, `${d}/${name}`)) paths.push(p);
    }
    for (const path of paths) await store.put(`${prefix}${path}`, await readFile(join(root, path)));
  }
  for (const name of await readdir(join(root, AGENTS_DIR)).catch(() => {
    throw new WorkflowParseError(AGENTS_DIR, "directory not found");
  })) {
    if (name.endsWith(".md") && name !== "AGENTS.md") {
      await store.put(
        `${prefix}${AGENTS_DIR}/${name}`,
        await readFile(join(root, AGENTS_DIR, name)),
      );
    }
  }
  await store.put(`${prefix}${DONE}`, new TextEncoder().encode(commit));
}

/** Snapshots `dir` (`workflows/workflow-<name>`) unless the run already has one, then reads the snapshot. */
export async function loadWorkflow(dir: string, options: LoadOptions): Promise<WorkflowDefinition> {
  workflowDirSchema.parse(dir);
  await snapshot(dir, options);
  const { store, prefix } = options;
  const texts = new Map<string, string>();
  for (const key of await store.list(prefix)) {
    const path = key.slice(prefix.length);
    if (/(^|\/)SKILL\.md$|(^|\/)(outputs|tasks)\.json$|^workflows\/agents\/[^/]+\.md$/.test(path))
      texts.set(path, await store.get(key));
  }

  const own = texts.get(`${dir}/SKILL.md`);
  if (own === undefined) throw new WorkflowParseError(`${dir}/SKILL.md`, "not found");
  const dirs = [dir, ...frontmatter(`${dir}/SKILL.md`, own).uses];
  const skills: Skill[] = [];
  for (const d of dirs) {
    for (const [path, text] of texts) {
      const m = new RegExp(`^${d.replace(/[.]/g, "\\.")}/((?:skills/[^/]+/)?)SKILL\\.md$`).exec(
        path,
      );
      if (!m) continue;
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

  const agents: Record<string, AgentDefinition> = {};
  for (const [path, text] of texts) {
    if (!path.startsWith(`${AGENTS_DIR}/`)) continue;
    const agent = parseAgent(path, text, options.knownTools);
    agents[agent.name] = agent;
  }
  return { dir, commit: await store.get(`${prefix}${DONE}`), files: files.data, skills, agents };
}
