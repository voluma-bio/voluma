/**
 * Reads `workflow.md`, `agents/*.md` and `skills/*\/SKILL.md` into a `WorkflowDefinition`.
 * Pure: the caller has already loaded the files. Every failure is a `WorkflowParseError`
 * naming the file and the heading, so a person writing a workflow can find the line.
 */
import { declaredOutputSchema, workflowPlanSchema } from "@voluma/contracts/workflow";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import {
  type Agent,
  ROLES,
  type Role,
  type Skill,
  type WorkflowDefinition,
  WorkflowParseError,
} from "./definition";

/** One pinned package's files, paths relative to its root, and where it is mounted. */
export interface PackageFiles {
  /** `/workflow/<repo>/<commit>[/<path>]`, the package root in the sandbox. */
  mount: string;
  files: ReadonlyMap<string, string>;
}

/** Splits `---` frontmatter from the body; a file with none has `{}` and the whole text. */
function frontmatter(file: string, text: string): { data: unknown; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/.exec(text);
  if (!m) return { data: {}, body: text };
  try {
    return { data: parseYaml(m[1] ?? "") ?? {}, body: m[2] ?? "" };
  } catch (e) {
    throw new WorkflowParseError(file, "frontmatter", (e as Error).message);
  }
}

function yamlBlock(file: string, where: string, text: string): unknown {
  try {
    return parseYaml(text) ?? null;
  } catch (e) {
    throw new WorkflowParseError(file, where, `invalid YAML: ${(e as Error).message}`);
  }
}

/** Validates with zod; any key the schema did not name is an error, so a typo is not dropped. */
function check<S extends z.ZodType>(
  file: string,
  where: string,
  schema: S,
  value: unknown,
): z.infer<S> {
  const r = schema.safeParse(value);
  if (!r.success) {
    const issue = r.error.issues[0];
    const at = issue?.path.length ? `${issue.path.join(".")}: ` : "";
    throw new WorkflowParseError(file, where, `${at}${issue?.message ?? "invalid"}`);
  }
  return r.data;
}

interface Section {
  heading: string;
  /** Lines under the heading, up to the next `## `. */
  lines: string[];
}

/** Splits at `## ` headings outside code fences; `intro` is what precedes the first. */
function sections(body: string): { intro: string; sections: Section[] } {
  const intro: string[] = [];
  const out: Section[] = [];
  let fence = false;
  for (const line of body.split(/\r?\n/)) {
    if (/^(```|~~~)/.test(line)) fence = !fence;
    const h = !fence && /^## (.+?)\s*$/.exec(line);
    if (h) out.push({ heading: h[1] ?? "", lines: [] });
    else (out.at(-1)?.lines ?? intro).push(line);
  }
  return { intro: intro.join("\n").trim(), sections: out };
}

/** The first fenced yaml block of a section and the prose around it. */
function splitBlock(lines: string[]): { yaml?: string; prose: string[] } {
  const start = lines.findIndex((l) => /^```ya?ml\s*$/.test(l));
  if (start < 0) return { prose: lines };
  const end = lines.findIndex((l, i) => i > start && /^```\s*$/.test(l));
  if (end < 0) return { prose: lines };
  return {
    yaml: lines.slice(start + 1, end).join("\n"),
    prose: [...lines.slice(0, start), ...lines.slice(end + 1)],
  };
}

/** `### Done when` bullets split off a task's prose. */
function splitDone(prose: string[]): { text: string; doneWhen: string[]; headed: boolean } {
  const i = prose.findIndex((l) => /^### Done when\s*$/.test(l));
  const head = i < 0 ? prose : prose.slice(0, i);
  const done = i < 0 ? [] : prose.slice(i + 1);
  const doneWhen = done
    .map((l) => /^\s*[-*]\s+(.*\S)\s*$/.exec(l)?.[1])
    .filter((l): l is string => l !== undefined);
  return { text: head.join("\n").trim(), doneWhen, headed: i >= 0 };
}

const FILE = "workflow.md";
const taskBlock = z.strictObject({
  depends: z.array(z.string()).default([]),
  outputs: z.array(z.record(z.string(), z.unknown())).default([]),
});
const frontmatterSchema = z.strictObject({
  name: z.string().min(1),
  title: z.string().min(1),
  roles: z.record(z.string(), z.string()).default({}),
});
const catalogEntry = z.looseObject({ id: z.string().min(1), name: z.string().min(1) });

/** A declared output as written: `required` defaults to true; an unknown key is an error. */
function output(where: string, raw: Record<string, unknown>) {
  const parsed = check(FILE, where, declaredOutputSchema, { required: true, ...raw });
  const extra = Object.keys(raw).filter((k) => !(k in parsed));
  if (extra.length) {
    throw new WorkflowParseError(
      FILE,
      where,
      `unknown key "${extra[0]}" for kind "${parsed.kind}"`,
    );
  }
  return parsed;
}

function readAgent(file: string, text: string): Agent {
  const { data, body } = frontmatter(file, text);
  const fm = check(
    file,
    "frontmatter",
    z.looseObject({
      name: z.string().min(1),
      model: z.string().optional(),
      skills: z
        .strictObject({
          load: z.array(z.string()).default([]),
          available: z.array(z.string()).default([]),
        })
        .default({ load: [], available: [] }),
      tools: z.array(z.string()).default([]),
    }),
    data,
  );
  return {
    name: fm.name,
    model: fm.model,
    instructions: body.trim(),
    load: fm.skills.load,
    available: fm.skills.available,
    tools: fm.tools,
  };
}

function readSkill(file: string, dir: string, mount: string, text: string): Skill {
  const fm = check(
    file,
    "frontmatter",
    z.looseObject({ name: z.string().min(1), description: z.string().min(1) }),
    frontmatter(file, text).data,
  );
  if (fm.name !== dir) {
    throw new WorkflowParseError(
      file,
      "frontmatter",
      `name "${fm.name}" must match its directory "${dir}"`,
    );
  }
  return {
    name: dir,
    description: fm.description.replace(/\s+/g, " ").trim(),
    path: `${mount}/skills/${dir}`,
  };
}

/**
 * `packages[0]` is the workflow (it holds `workflow.md`); the rest supply agents and
 * skills it may name. Skills and agents are looked up across all of them.
 */
export function parseWorkflow(packages: readonly PackageFiles[]): WorkflowDefinition {
  const [root] = packages;
  const text = root?.files.get(FILE);
  if (text === undefined)
    throw new WorkflowParseError(FILE, "", "not found in the first pinned package");

  const agents = new Map<string, Agent>();
  const skills: Skill[] = [];
  for (const pkg of packages) {
    for (const [path, content] of pkg.files) {
      const agent = /^agents\/([^/]+)\.md$/.exec(path);
      if (agent) {
        const a = readAgent(path, content);
        if (!agents.has(a.name)) agents.set(a.name, a);
        continue;
      }
      const skill = /^skills\/([^/]+)\/SKILL\.md$/.exec(path);
      if (skill?.[1]) skills.push(readSkill(path, skill[1], pkg.mount, content));
    }
  }

  const { data, body } = frontmatter(FILE, text);
  const fm = check(FILE, "frontmatter", frontmatterSchema, data);
  const parts = sections(body);

  const roles: Partial<Record<Role, Agent>> = {};
  for (const [role, name] of Object.entries(fm.roles)) {
    if (!(ROLES as readonly string[]).includes(role)) {
      throw new WorkflowParseError(
        FILE,
        "frontmatter",
        `roles.${role}: unknown role (one of ${ROLES.join(", ")})`,
      );
    }
    const agent = agents.get(name);
    if (!agent) {
      throw new WorkflowParseError(
        FILE,
        "frontmatter",
        `roles.${role}: no agent "${name}" in the pinned packages`,
      );
    }
    roles[role as Role] = agent;
  }
  if (!roles.worker) throw new WorkflowParseError(FILE, "frontmatter", "roles.worker is required");

  const skillNames = new Set(skills.map((s) => s.name));
  for (const agent of new Set(Object.values(roles))) {
    for (const s of [...agent.load, ...agent.available]) {
      if (!skillNames.has(s)) {
        throw new WorkflowParseError(
          `agents/${agent.name}.md`,
          "skills",
          `skill "${s}" is not in the pinned packages`,
        );
      }
    }
  }

  const tasks: { id: string; dependsOn: string[]; doneWhen?: string[]; outputs: unknown[] }[] = [];
  const instructions: Record<string, string> = {};
  let parameters: unknown[] = [];
  let structures: unknown[] = [];
  let review: unknown = {};
  for (const section of parts.sections) {
    const { yaml, prose } = splitBlock(section.lines);
    const where = `## ${section.heading}`;
    const task = /^Task: (\S+)$/.exec(section.heading);
    if (task?.[1]) {
      const id = task[1];
      if (yaml === undefined)
        throw new WorkflowParseError(FILE, where, "missing the ```yaml block (depends, outputs)");
      const block = check(FILE, where, taskBlock, yamlBlock(FILE, where, yaml) ?? {});
      const { text: prosetext, doneWhen, headed } = splitDone(prose);
      if (headed && doneWhen.length === 0) {
        throw new WorkflowParseError(FILE, where, "### Done when has no bullets (- criterion)");
      }
      tasks.push({
        id,
        dependsOn: block.depends,
        ...(doneWhen.length && { doneWhen }),
        outputs: block.outputs.map((o, i) => output(`${where}, outputs[${i}]`, o)),
      });
      instructions[id] = prosetext;
    } else if (section.heading === "Parameters" || section.heading === "Structures") {
      const list = check(FILE, where, z.array(catalogEntry), yamlBlock(FILE, where, yaml ?? ""));
      if (section.heading === "Parameters") parameters = list;
      else structures = list;
    } else if (section.heading === "Review") {
      review = yamlBlock(FILE, where, yaml ?? "") ?? {};
    } else {
      throw new WorkflowParseError(
        FILE,
        where,
        'unknown heading (expected "Parameters", "Structures", "Task: <id>" or "Review")',
      );
    }
  }

  const plan = workflowPlanSchema.safeParse({ tasks });
  if (!plan.success) {
    const issue = plan.error.issues[0];
    throw new WorkflowParseError(FILE, "tasks", `${issue?.path.join(".")}: ${issue?.message}`);
  }
  return {
    name: fm.name,
    title: fm.title,
    intro: parts.intro,
    plan: plan.data,
    instructions,
    parameters,
    structures,
    review,
    roles,
    skills,
  };
}
