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

/** A directory of the repo as a workflow reads it: `workflows/<name>`, no `..`, no trailing slash. */
export const workflowDirSchema = z
  .string()
  .regex(/^workflows\/[a-z0-9._-]+(\/[a-z0-9._-]+)*$/)
  .refine((d) => !d.split("/").some((p) => /^\.+$/.test(p)), "must not contain . or ..");

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

/**
 * A task's `### Done when` section: bullets, each with its indented continuation lines.
 * It ends the task's prose, so any other non-blank line after it is refused, not dropped.
 */
function splitDone(
  where: string,
  prose: string[],
): { text: string; doneWhen: string[]; headed: boolean } {
  const i = prose.findIndex((l) => /^### Done when\s*$/.test(l));
  const head = i < 0 ? prose : prose.slice(0, i);
  const doneWhen: string[] = [];
  for (const line of i < 0 ? [] : prose.slice(i + 1)) {
    if (line.trim() === "") continue;
    const bullet = /^[-*]\s+(.*\S)\s*$/.exec(line);
    if (bullet?.[1]) doneWhen.push(bullet[1]);
    else if (/^\s+\S/.test(line) && doneWhen.length > 0) {
      doneWhen[doneWhen.length - 1] += ` ${line.trim()}`;
    } else {
      throw new WorkflowParseError(
        FILE,
        where,
        `"### Done when" must be the last part of a task, bullets only; found "${line.trim()}"`,
      );
    }
  }
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
  /** Other workflow directories whose `agents/` and `skills/` this workflow may use. */
  uses: z.array(workflowDirSchema).default([]),
});
const parameterEntry = z.strictObject({
  id: z.string().min(1),
  name: z.string().min(1),
  unit: z.string().min(1).optional(),
  description: z.string().optional(),
});
const structureEntry = z.strictObject({
  id: z.string().min(1),
  name: z.string().min(1),
  label: z.number().int().positive().optional(),
  find: z.string().optional(),
});
const reviewBlock = z.strictObject({
  "default-layout": z.array(z.string()).default([]),
  "per-task": z
    .record(
      z.string(),
      z.strictObject({
        show: z.array(z.string()).default([]),
        table: z.array(z.string()).default([]),
      }),
    )
    .default({}),
});
/**
 * Keys of Mars agent files that Voluma does not read. Every other key must be one Voluma
 * reads, so a typo such as `tool:` fails instead of silently dropping the tool.
 */
const MARS_AGENT_KEYS = [
  "description",
  "effort",
  "model-policies",
  "sandbox",
  "harness",
  "approval",
  "mode",
  "type",
] as const;

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
    z.strictObject({
      name: z.string().min(1),
      model: z.string().optional(),
      skills: z
        .strictObject({
          load: z.array(z.string()).default([]),
          available: z.array(z.string()).default([]),
        })
        .default({ load: [], available: [] }),
      tools: z.array(z.string()).default([]),
      ...Object.fromEntries(MARS_AGENT_KEYS.map((k) => [k, z.unknown().optional()])),
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

function readSkill(file: string, dir: string, base: string, text: string): Skill {
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
    path: `/workflow/${base}/skills/${dir}`,
  };
}

/** Where the catalogs and the review template name tasks and outputs, they must agree. */
function crossCheck(
  plan: z.infer<typeof workflowPlanSchema>,
  parameters: z.infer<typeof parameterEntry>[],
  structures: z.infer<typeof structureEntry>[],
  review: z.infer<typeof reviewBlock>,
) {
  const fail = (where: string, message: string) => {
    throw new WorkflowParseError(FILE, where, message);
  };
  const outputIds = new Set<string>();
  for (const t of plan.tasks) {
    for (const o of t.outputs) {
      outputIds.add(o.id);
      const where = `## Task: ${t.id}, output ${o.id}`;
      if (o.kind === "measurement") {
        const p = parameters.find((x) => x.id === o.id);
        if (p?.unit && p.unit !== o.unit) {
          fail(where, `unit "${o.unit}" disagrees with the parameter catalog's "${p.unit}"`);
        }
      }
      if (o.kind === "structure") {
        const st = structures.find((x) => x.id === o.id);
        if (st?.label !== undefined && o.label !== undefined && st.label !== o.label) {
          fail(where, `label ${o.label} disagrees with the structure catalog's ${st.label}`);
        }
        if (st && o.name !== undefined && st.name !== o.name) {
          fail(where, `name "${o.name}" disagrees with the structure catalog's "${st.name}"`);
        }
      }
    }
  }
  const known = new Set([...outputIds, ...structures.map((x) => x.id)]);
  const taskIds = new Set(plan.tasks.map((t) => t.id));
  for (const [task, v] of Object.entries(review["per-task"])) {
    if (!taskIds.has(task)) fail("## Review", `per-task.${task}: not a task of the plan`);
    for (const id of [...v.show, ...v.table]) {
      if (!known.has(id))
        fail("## Review", `per-task.${task}: "${id}" is neither an output nor a structure`);
    }
  }
}

/**
 * `dir` is the workflow's directory (`workflows/<name>`) and `files` the text files of the
 * snapshot, keyed by repo path. The workflow's `workflow.md` names, in `uses`, other
 * directories whose agents and skills it may use; agents and skills are looked up in all of them.
 */
export function parseWorkflow(dir: string, files: ReadonlyMap<string, string>): WorkflowDefinition {
  const text = files.get(`${dir}/${FILE}`);
  if (text === undefined) throw new WorkflowParseError(`${dir}/${FILE}`, "", "not found");

  const agents = new Map<string, Agent>();
  const skills: Skill[] = [];
  const dirs = [
    dir,
    ...check(FILE, "frontmatter", frontmatterSchema, frontmatter(FILE, text).data).uses,
  ];
  for (const base of dirs) {
    for (const [path, content] of files) {
      if (!path.startsWith(`${base}/`)) continue;
      const rel = path.slice(base.length + 1);
      const agent = /^agents\/([^/]+)\.md$/.exec(rel);
      if (agent) {
        const a = readAgent(path, content);
        if (agents.has(a.name)) {
          throw new WorkflowParseError(path, "frontmatter", `agent "${a.name}" is defined twice`);
        }
        agents.set(a.name, a);
        continue;
      }
      const skill = /^skills\/([^/]+)\/SKILL\.md$/.exec(rel);
      if (skill?.[1]) {
        const sk = readSkill(path, skill[1], base, content);
        if (skills.some((x) => x.name === sk.name)) {
          throw new WorkflowParseError(path, "frontmatter", `skill "${sk.name}" is defined twice`);
        }
        skills.push(sk);
      }
    }
  }

  const { data, body } = frontmatter(FILE, text);
  const fm = check(FILE, "frontmatter", frontmatterSchema, data);
  const parts = sections(body);

  const assigned: Partial<Record<Role, Agent>> = {};
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
        `roles.${role}: no agent "${name}" in the workflow or the directories it uses`,
      );
    }
    assigned[role as Role] = agent;
  }
  if (!assigned.worker) {
    throw new WorkflowParseError(FILE, "frontmatter", "roles.worker is required");
  }
  const roles = { ...assigned, worker: assigned.worker };

  const skillNames = new Set(skills.map((s) => s.name));
  for (const agent of new Set(Object.values(roles))) {
    for (const s of [...agent.load, ...agent.available]) {
      if (!skillNames.has(s)) {
        throw new WorkflowParseError(
          `agents/${agent.name}.md`,
          "skills",
          `skill "${s}" is not in the workflow or the directories it uses`,
        );
      }
    }
  }

  const tasks: { id: string; dependsOn: string[]; doneWhen?: string[]; outputs: unknown[] }[] = [];
  const instructions: Record<string, string> = {};
  let parameters: z.infer<typeof parameterEntry>[] = [];
  let structures: z.infer<typeof structureEntry>[] = [];
  let review: z.infer<typeof reviewBlock> = reviewBlock.parse({});
  for (const section of parts.sections) {
    const { yaml, prose } = splitBlock(section.lines);
    const where = `## ${section.heading}`;
    const task = /^Task: (\S+)$/.exec(section.heading);
    if (task?.[1]) {
      const id = task[1];
      if (yaml === undefined)
        throw new WorkflowParseError(FILE, where, "missing the ```yaml block (depends, outputs)");
      const block = check(FILE, where, taskBlock, yamlBlock(FILE, where, yaml) ?? {});
      const { text: prosetext, doneWhen, headed } = splitDone(where, prose);
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
      const raw = yamlBlock(FILE, where, yaml ?? "");
      if (section.heading === "Parameters")
        parameters = check(FILE, where, z.array(parameterEntry), raw);
      else structures = check(FILE, where, z.array(structureEntry), raw);
    } else if (section.heading === "Review") {
      review = check(FILE, where, reviewBlock, yamlBlock(FILE, where, yaml ?? "") ?? {});
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
  crossCheck(plan.data, parameters, structures, review);
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
