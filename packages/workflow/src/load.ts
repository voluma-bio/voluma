/**
 * A run's view of its workflow: `loadWorkflow` snapshots the workflow's directories from
 * the runner's checkout into the run's R2 prefix when the run starts (`workflowSnapshotPrefix`)
 * and parses the snapshot, never the checkout, so a resume after a redeploy that changed
 * the files reads what the run began with. IO goes through `WorkflowStore`, so this package
 * holds no S3 client.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { WorkflowDefinition } from "./definition";
import { WorkflowParseError } from "./definition";
import { parseWorkflow, workflowDirSchema } from "./parse";

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
}

/** Written last, so a snapshot cut short is redone, not trusted. */
const DONE = ".snapshot-done";
/** What of a workflow directory the run needs: its plan, agents and skills with their resources. */
const PARTS = ["workflow.md", "agents", "skills"];

async function* files(root: string, rel: string): AsyncGenerator<string> {
  for (const entry of await readdir(join(root, rel), { withFileTypes: true })) {
    const path = `${rel}/${entry.name}`;
    if (entry.isDirectory()) yield* files(root, path);
    else if (entry.isFile()) yield path;
  }
}

/** The directories `dir`'s `workflow.md` lists in `uses`, read from the checkout. */
async function usedDirs(root: string, dir: string): Promise<string[]> {
  const text = await readFile(join(root, dir, "workflow.md"), "utf8").catch(() => {
    throw new WorkflowParseError(`${dir}/workflow.md`, "", "not found");
  });
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? "";
  const uses = (parseYaml(fm) as { uses?: unknown } | null)?.uses ?? [];
  return workflowDirSchema.array().parse(uses);
}

async function snapshot(dir: string, { store, prefix, root }: LoadOptions) {
  if (await store.has(`${prefix}${DONE}`)) return;
  for (const d of [dir, ...(await usedDirs(root, dir))]) {
    for (const part of PARTS) {
      const exists = await readdir(join(root, d)).then((names) => names.includes(part));
      if (!exists) continue;
      const paths = part === "workflow.md" ? [`${d}/${part}`] : files(root, `${d}/${part}`);
      for await (const path of paths) {
        await store.put(`${prefix}${path}`, await readFile(join(root, path)));
      }
    }
  }
  await store.put(`${prefix}${DONE}`, new Uint8Array());
}

/** Snapshots `dir` (`workflows/<name>`) unless the run already has one, then parses the snapshot. */
export async function loadWorkflow(dir: string, options: LoadOptions): Promise<WorkflowDefinition> {
  workflowDirSchema.parse(dir);
  await snapshot(dir, options);
  const { store, prefix } = options;
  const keys = (await store.list(prefix)).filter((k) =>
    /(^|\/)(workflow\.md|agents\/[^/]+\.md|skills\/[^/]+\/SKILL\.md)$/.test(k.slice(prefix.length)),
  );
  const texts = new Map<string, string>();
  for (const key of keys) texts.set(key.slice(prefix.length), await store.get(key));
  return parseWorkflow(dir, texts);
}
