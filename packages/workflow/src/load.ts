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
import { workflowMountPath } from "./mount";
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
  /** A GitHub token: required for private repos, and unauthenticated calls are rate-limited per IP. */
  githubToken?: string;
  /** Aborts the import's fetches (a cancelled or shutting-down run). */
  signal?: AbortSignal;
}

/**
 * Marks a finished import: written last, so a crashed import is redone, not trusted. The
 * version names the rules (`WANTED`, the size cap); raise it when they change, and every
 * pin is imported again under the new ones.
 */
const IMPORT_VERSION = 1;
const DONE = `.imported-v${IMPORT_VERSION}`;
/** The files of a package Voluma reads or the sandbox needs: manifest, plan, agents, skills. */
const WANTED = /^(mars\.toml|workflow\.md|agents\/.+|skills\/.+)$/;
const FETCH_CONCURRENCY = 8;
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 30_000;
const ATTEMPTS = 4;
const LFS_POINTER = "version https://git-lfs.github.com/spec";

/** A GET that retries a transient failure (network, 5xx, 429) with backoff. */
async function github(url: string, { githubToken, signal }: ImportOptions): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    let failure: string;
    try {
      const res = await fetch(url, {
        headers: {
          ...(githubToken && { Authorization: `Bearer ${githubToken}` }),
          "User-Agent": "voluma-runner",
        },
        signal: AbortSignal.any([
          AbortSignal.timeout(FETCH_TIMEOUT_MS),
          ...(signal ? [signal] : []),
        ]),
      });
      if (res.ok) return res;
      if (res.status < 500 && res.status !== 429)
        throw new Error(`GET ${url} answered ${res.status}`);
      failure = `answered ${res.status}`;
    } catch (error) {
      if (
        signal?.aborted ||
        !(error instanceof TypeError || (error as Error).name === "TimeoutError")
      ) {
        throw error;
      }
      failure = (error as Error).message;
    }
    if (attempt === ATTEMPTS)
      throw new Error(`GET ${url} failed after ${ATTEMPTS} tries: ${failure}`);
    await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
  }
}

export async function importPin(pin: WorkflowPin, options: ImportOptions) {
  const { store } = options;
  const prefix = workflowPrefix(pin);
  if (await store.has(`${prefix}${DONE}`)) return;

  const base = pin.path ? `${pin.path}/` : "";
  const tree = (await (
    await github(
      `https://api.github.com/repos/${pin.repo}/git/trees/${pin.commit}?recursive=1`,
      options,
    )
  ).json()) as { truncated: boolean; tree: { path: string; type: string; size?: number }[] };
  if (tree.truncated) {
    throw new Error(`${pin.repo}@${pin.commit}: the file tree is too large to list`);
  }
  const entries = tree.tree
    .filter((e) => e.type === "blob" && e.path.startsWith(base))
    .map((e) => ({ file: e.path.slice(base.length), size: e.size ?? 0 }))
    .filter((e) => WANTED.test(e.file));
  if (!entries.some((e) => e.file === "mars.toml")) {
    throw new Error(
      `${pin.repo}@${pin.commit}${pin.path ? `/${pin.path}` : ""} has no mars.toml: not a Mars package`,
    );
  }
  const big = entries.find((e) => e.size > MAX_FILE_BYTES);
  if (big)
    throw new Error(
      `${pin.repo}@${pin.commit}: ${base}${big.file} is over ${MAX_FILE_BYTES} bytes`,
    );

  for (let i = 0; i < entries.length; i += FETCH_CONCURRENCY) {
    await Promise.all(
      entries.slice(i, i + FETCH_CONCURRENCY).map(async ({ file }) => {
        const res = await github(
          `https://raw.githubusercontent.com/${pin.repo}/${pin.commit}/${base}${file}`,
          options,
        );
        const bytes = new Uint8Array(await res.arrayBuffer());
        if (new TextDecoder().decode(bytes.subarray(0, LFS_POINTER.length)) === LFS_POINTER) {
          throw new Error(
            `${pin.repo}@${pin.commit}: ${base}${file} is a Git LFS pointer; commit the file itself`,
          );
        }
        await store.put(`${prefix}${file}`, bytes);
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
  return { mount: workflowMountPath(pin), files };
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
