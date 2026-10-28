/**
 * Brings a run's pinned packages into R2 and reads them: `importPin` copies the files a
 * run needs from GitHub to the pin's prefix (`workflowPrefix`), once per commit, and
 * `loadWorkflow` imports every pin and parses the first as the workflow. IO goes through
 * `WorkflowStore`, so this package holds no S3 client.
 */
import { workflowPrefix } from "@voluma/contracts/r2";
import type { WorkflowPin } from "@voluma/contracts/workflow";
import type { WorkflowDefinition } from "./definition";
import { WorkflowParseError } from "./definition";
import { type PackageFiles, parseWorkflow } from "./parse";

/** The bucket, as the importer needs it. Keys are R2 keys. */
export interface WorkflowStore {
  has(key: string): Promise<boolean>;
  put(key: string, body: Uint8Array): Promise<void>;
  /** Every key under `prefix`. */
  list(prefix: string): Promise<string[]>;
  get(key: string): Promise<string>;
}

export interface ImportOptions {
  store: WorkflowStore;
  /** A GitHub token for private repos. */
  githubToken?: string;
}

/** Marks a finished import: written last, so a crashed import is redone, not trusted. */
const DONE = ".imported";
/** The files of a package Voluma reads or the sandbox needs: manifest, plan, agents, skills. */
const WANTED = /^(mars\.toml|workflow\.md|agents\/.+|skills\/.+)$/;
const FETCH_CONCURRENCY = 8;

async function github(url: string, token: string | undefined): Promise<Response> {
  const res = await fetch(url, {
    headers: { ...(token && { Authorization: `Bearer ${token}` }), "User-Agent": "voluma-runner" },
  });
  if (!res.ok) throw new Error(`GET ${url} answered ${res.status}`);
  return res;
}

export async function importPin(pin: WorkflowPin, { store, githubToken }: ImportOptions) {
  const prefix = workflowPrefix(pin);
  if (await store.has(`${prefix}${DONE}`)) return;

  const base = pin.path ? `${pin.path}/` : "";
  const tree = (await (
    await github(
      `https://api.github.com/repos/${pin.repo}/git/trees/${pin.commit}?recursive=1`,
      githubToken,
    )
  ).json()) as { truncated: boolean; tree: { path: string; type: string }[] };
  if (tree.truncated)
    throw new Error(`${pin.repo}@${pin.commit}: the file tree is too large to list`);
  const files = tree.tree
    .filter((e) => e.type === "blob" && e.path.startsWith(base))
    .map((e) => e.path.slice(base.length))
    .filter((p) => WANTED.test(p));
  if (!files.includes("mars.toml")) {
    throw new Error(
      `${pin.repo}@${pin.commit}${pin.path ? `/${pin.path}` : ""} has no mars.toml: not a Mars package`,
    );
  }

  for (let i = 0; i < files.length; i += FETCH_CONCURRENCY) {
    await Promise.all(
      files.slice(i, i + FETCH_CONCURRENCY).map(async (file) => {
        const res = await github(
          `https://raw.githubusercontent.com/${pin.repo}/${pin.commit}/${base}${file}`,
          githubToken,
        );
        await store.put(`${prefix}${file}`, new Uint8Array(await res.arrayBuffer()));
      }),
    );
  }
  await store.put(`${prefix}${DONE}`, new Uint8Array());
}

/** The text files `parseWorkflow` reads, from an imported pin. */
async function readPackage(pin: WorkflowPin, store: WorkflowStore): Promise<PackageFiles> {
  const prefix = workflowPrefix(pin);
  const keys = (await store.list(prefix)).filter((k) =>
    /^(workflow\.md|agents\/[^/]+\.md|skills\/[^/]+\/SKILL\.md)$/.test(k.slice(prefix.length)),
  );
  const files = new Map<string, string>();
  for (const key of keys) files.set(key.slice(prefix.length), await store.get(key));
  return { mount: `/workflow/${prefix.slice("workflows/".length).replace(/\/$/, "")}`, files };
}

/**
 * `pins[0]` is the workflow and the others are the packages it draws agents and skills
 * from. The catalog lists every package, so the run's pins are all of them and no
 * dependency is resolved here.
 */
export async function loadWorkflow(
  pins: readonly WorkflowPin[],
  options: ImportOptions,
): Promise<WorkflowDefinition> {
  if (pins.length === 0)
    throw new WorkflowParseError("workflow.md", "", "the run pins no packages");
  for (const pin of pins) await importPin(pin, options);
  const packages = await Promise.all(pins.map((p) => readPackage(p, options.store)));
  return parseWorkflow(packages);
}
