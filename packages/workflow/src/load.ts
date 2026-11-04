/**
 * A run's view of its workflow: `loadWorkflow` snapshots `workflows/core/` and the run's workflow
 * directory (`workflows/<name>/`) from the runner's checkout into the run's R2 prefix when the
 * run starts (`workflowSnapshotPrefix`), and reads the snapshot, never the checkout, so a
 * resume after a redeploy that changed the files sees what the run began with. IO goes through
 * an `ObjectStore`, so this package holds no S3 client.
 *
 * Both directories hold skills, `skills/<name>/SKILL.md` with optional `references/` and
 * `resources/`. `core/` also holds the role files, the same for every workflow: `agents/<role>.md`
 * (with `agents/words.md` and `agents/environment.md`, text every role's prompt ends with, and `agents/review.md`, the review main's). The
 * workflow's directory adds `outputs.yaml`. `core/convert/` (the review converter, run by the
 * runner's convert sandbox) is snapshotted too; nothing else in either directory is.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { type OutputCatalog, outputCatalogSchema } from "@voluma/contracts/output-catalog";
import { deletePrefix, getText, type ObjectStore } from "@voluma/object-store";
import { isScalar, parseDocument, parse as parseYaml, visit } from "yaml";
import { z } from "zod";
import {
  type AgentDefinition,
  OLDER_VERSION_MESSAGE,
  type Skill,
  THINKING_LEVELS,
  type ToolIndexEntry,
  type WorkflowDefinition,
  WorkflowParseError,
} from "./definition";
import { docstringSummary } from "./docstring";

export interface LoadOptions {
  store: ObjectStore;
  /** The run's snapshot prefix (`workflowSnapshotPrefix(runId)`). */
  prefix: string;
  /** The checkout the workflows are read from: the repo root. */
  root: string;
  /** The commit that checkout is at, written into the snapshot's marker. */
  commit: string;
  /** The tool names a role may list (`AGENT_TOOL_NAMES`). */
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
const SKILL_KEYS = [
  "license",
  "compatibility",
  "metadata",
  "allowed-tools",
  "type",
  "harness", // OVERLAP: snapshots cut before the task loop was deleted; see `rolesDirOf`
] as const;
const frontmatterSchema = z.strictObject({
  name: z.string().min(1),
  description: z.string().min(1),
  /** Skills that load beside this one (core skills the method leans on). */
  companions: z.array(z.string().min(1)).optional(),
  ...Object.fromEntries(SKILL_KEYS.map((k) => [k, z.unknown().optional()])),
});

/** The role files, the same for every workflow. */
const ROLES_DIR = `${CORE}/agents`;
/**
 * OVERLAP, delete with the `harness` skill key above once no run snapshotted before the task loop
 * was deleted can still be resumed (TODO in packages/workflow/.context/TODO.md): such a snapshot
 * keeps the roles in `core/roles/` and holds a `core/agents/` of task-loop roles to ignore.
 */
const OLD_ROLES_DIR = `${CORE}/roles`;
async function rolesDirOf(store: ObjectStore, prefix: string, existing: boolean) {
  return existing && (await store.head(`${prefix}${OLD_ROLES_DIR}/main.md`))
    ? OLD_ROLES_DIR
    : ROLES_DIR;
}

/** Files of `agents/` that are prompt texts, not roles: `words.md` and `environment.md` go in every role's prompt, `review.md` in a review main's. */
const PROMPT_TEXTS = ["words.md", "environment.md", "review.md"];
const agentSchema = z.strictObject({
  name: z.string().min(1),
  description: z.string().min(1),
  model: z.string().min(1),
  thinking: z.enum(THINKING_LEVELS).optional(),
  tools: z.array(z.string().min(1)),
  skills: z.array(z.string().min(1)).optional(),
});

/** Written last, so a snapshot cut short is redone, not trusted; its body is the commit. */
const DONE = ".snapshot-done";

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

const frontmatter = (file: string, text: string) => parseFile(file, text, frontmatterSchema);

/** `skills` still unresolved: `parseAgent` leaves the default to the caller, who knows the skills. */
type ParsedAgent = Omit<AgentDefinition, "skills"> & { skills?: string[] };

function parseAgent(
  path: string,
  text: string,
  knownTools: readonly string[],
  existing: boolean,
): ParsedAgent {
  const { data, body } = parseFile(path, text, agentSchema);
  const name = path.slice(path.lastIndexOf("/") + 1, -".md".length);
  if (data.name !== name) {
    throw new WorkflowParseError(path, `name "${data.name}" must match its file name "${name}"`);
  }
  const unknown = data.tools.find((t) => !knownTools.includes(t));
  if (unknown) {
    // In a snapshot an earlier run wrote, a tool the harness has since dropped means the run is
    // from an older version; in one just cut from the checkout it is a typo.
    if (existing) throw new Error(OLDER_VERSION_MESSAGE);
    throw new WorkflowParseError(path, `tool "${unknown}" is not a tool of the agent loop`);
  }
  if (!body) throw new WorkflowParseError(path, "the body is empty");
  if (!data.tools.includes("bash") && data.tools.includes("segment_sam")) {
    throw new WorkflowParseError(path, "segment_sam needs a sandbox, which holding bash gives");
  }
  return {
    name,
    description: data.description.replace(/\s+/g, " ").trim(),
    model: data.model,
    thinking: data.thinking,
    tools: data.tools,
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

/** Writes the snapshot unless the run has one; true when it was already there. */
async function snapshot(dir: string, { store, prefix, root, commit }: LoadOptions) {
  if (await store.head(`${prefix}${DONE}`)) return true;
  // No marker: an earlier attempt was cut off. Its files may be ones this checkout no longer
  // has, so start from an empty prefix instead of copying over them.
  await deletePrefix(store, prefix);
  const put = async (path: string) =>
    store.put(`${prefix}${path}`, await readFile(join(root, path)));
  for (const d of [CORE, dir]) {
    const names = await readdir(join(root, d)).catch(() => {
      throw new WorkflowParseError(d, "directory not found");
    });
    if (d === dir && names.includes("outputs.yaml")) await put(`${d}/outputs.yaml`);
    if (names.includes("skills")) for await (const p of walk(root, `${d}/skills`)) await put(p);
    // The review converter (`core/convert/`), which the runner's convert sandbox runs from /workflow.
    if (d === CORE && names.includes("convert"))
      for await (const p of walk(root, `${d}/convert`)) await put(p);
  }
  const roleFiles = await readdir(join(root, ROLES_DIR)).catch(() => {
    throw new WorkflowParseError(ROLES_DIR, "directory not found");
  });
  for (const name of roleFiles) {
    if (name.endsWith(".md") && name !== "AGENTS.md") await put(`${ROLES_DIR}/${name}`);
  }
  await store.put(`${prefix}${DONE}`, new TextEncoder().encode(commit));
  return false;
}

/** Snapshots `dir` (`workflows/<name>`) unless the run already has one, then reads the snapshot. */
export async function loadWorkflow(dir: string, options: LoadOptions): Promise<WorkflowDefinition> {
  workflowDirSchema.parse(dir);
  const existing = await snapshot(dir, options);
  const { store, prefix } = options;
  const rolesDir = await rolesDirOf(store, prefix, existing);
  const texts = new Map<string, string>();
  for (const { key } of (await store.list(prefix)).objects) {
    const path = key.slice(prefix.length);
    if (
      /(^|\/)SKILL\.md$|(^|\/)outputs\.yaml$|\/references\/suggested-plan\.md$/.test(path) ||
      (path.startsWith(`${rolesDir}/`) && /^[^/]+\.md$/.test(path.slice(rolesDir.length + 1))) ||
      scriptOf(path)
    )
      texts.set(path, await getText(store, key));
  }

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
    const { data: fm, body } = frontmatter(path, text);
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
      text: body,
      companions: fm.companions ?? [],
    });
  }
  for (const skill of skills) {
    const missing = skill.companions.find((c) => !skills.some((s) => s.name === c));
    if (missing)
      throw new WorkflowParseError(
        `${skill.path.slice("/workflow/".length)}/SKILL.md`,
        `companion "${missing}" is not a skill of this workflow`,
      );
  }

  const outputCatalog = (() => {
    const file = `${dir}/outputs.yaml`;
    const yaml = texts.get(file);
    if (yaml === undefined) throw new WorkflowParseError(file, "not found");
    const doc = parseDocument(yaml);
    if (doc.errors[0]) throw new WorkflowParseError(file, `invalid YAML: ${doc.errors[0].message}`);
    // PyYAML (YAML 1.1) reads a bare `on` key as `True`; the file and its copies are read from Python.
    visit(doc, {
      Pair(_, pair) {
        if (isScalar(pair.key) && pair.key.type === "PLAIN" && pair.key.value === "on")
          throw new WorkflowParseError(file, 'write the key as "on": quoted');
      },
    });
    const data: unknown = doc.toJS();
    const catalog = outputCatalogSchema.safeParse(data);
    if (!catalog.success) {
      const issue = catalog.error.issues[0];
      throw new WorkflowParseError(file, `${issue?.path.join(".")}: ${issue?.message}`);
    }
    return catalog.data;
  })();

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
    if (!path.startsWith(`${rolesDir}/`) || PROMPT_TEXTS.some((f) => path.endsWith(`/${f}`)))
      continue;
    const agent = parseAgent(path, text, options.knownTools, existing);
    found[agent.name] = agent;
  }
  const skillNames = skills.map((s) => s.name);
  const agents: Record<string, AgentDefinition> = {};
  for (const agent of Object.values(found)) {
    const path = `${rolesDir}/${agent.name}.md`;
    const unknown = agent.skills?.find((n) => !skillNames.includes(n));
    if (unknown)
      throw new WorkflowParseError(path, `skill "${unknown}" is not a skill of this workflow`);
    agents[agent.name] = { ...agent, skills: agent.skills ?? skillNames };
  }
  const { main } = agents;
  if (!main) throw new WorkflowParseError(`${rolesDir}/main.md`, "not found");
  const promptText = (name: string) => {
    const text = texts.get(`${rolesDir}/${name}`);
    if (text === undefined) throw new WorkflowParseError(`${rolesDir}/${name}`, "not found");
    return text.trim();
  };
  return {
    dir,
    commit: await getText(store, `${prefix}${DONE}`),
    skills,
    toolIndex,
    agents: { ...agents, main },
    outputCatalog,
    suggestedPlan: texts.get(`${own.slice(0, -"/SKILL.md".length)}/references/suggested-plan.md`),
    words: promptText("words.md"),
    environment: promptText("environment.md"),
    ...(texts.has(`${rolesDir}/review.md`) && { review: promptText("review.md") }),
  };
}
