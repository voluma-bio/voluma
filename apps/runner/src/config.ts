/**
 * The runner's settings: the repo's `.env` (or the file `VOLUMA_ENV_FILE` names) if there
 * is one, over which the process environment (Railway's variables) takes precedence. Read
 * into a plain object, never written to `process.env`, so keys are not inherited by child
 * processes or picked up by other libraries; callers pass each one on explicitly.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";

const file = process.env.VOLUMA_ENV_FILE ?? resolve(import.meta.dirname, "../../../.env");
const values: Record<string, string | undefined> = {
  ...(existsSync(file) ? parseEnv(readFileSync(file, "utf8")) : {}),
  ...process.env,
};

/** A setting that may be empty or absent. */
export const optional = (name: string): string | undefined => values[name] || undefined;

/** A setting that must be set. */
export function required(name: string): string {
  const value = optional(name);
  if (!value) throw new Error(`${name} is not set (in ${file} or the environment)`);
  return value;
}

function positiveInt(name: string, fallback: number, min = 1): number {
  const value = Number(optional(name) ?? fallback);
  if (!Number.isInteger(value) || value < min) {
    throw new Error(`${name} must be an integer of at least ${min}`);
  }
  return value;
}

/**
 * The API to claim from: `VOLUMA_API_URL` and `VOLUMA_API_TOKEN`, else the local API
 * `pnpm dev` started in this worktree (tools/dev.mjs writes `.dev/env.json`).
 */
function apiEndpoint(): { baseUrl: string; token: string } {
  const baseUrl = optional("VOLUMA_API_URL");
  const token = optional("VOLUMA_API_TOKEN");
  if (baseUrl || token) {
    return { baseUrl: required("VOLUMA_API_URL"), token: required("VOLUMA_API_TOKEN") };
  }
  const path = resolve(import.meta.dirname, "../../../.dev/env.json");
  try {
    const { apiUrl, apiToken } = JSON.parse(readFileSync(path, "utf8"));
    return { baseUrl: apiUrl, token: apiToken };
  } catch {
    throw new Error(`set VOLUMA_API_URL and VOLUMA_API_TOKEN, or run \`pnpm dev\` (${path})`);
  }
}

/** A model as `provider/id`, e.g. `openai/gpt-5.6-luna`. */
type ModelRef = { provider: string; id: string };
function modelRef(name: string, fallback?: string): ModelRef {
  const text = fallback ? (optional(name) ?? fallback) : required(name);
  const [provider, ...rest] = text.split("/");
  const id = rest.join("/");
  if (!provider || !id) throw new Error(`${name} must be provider/model-id, got "${text}"`);
  return { provider, id };
}

/**
 * A visitor run sends the visitor's Meta key with this model, so it must be a Meta model; a
 * `-contributor` one would let Meta train on the visitor's scan.
 */
function visitorModel(): ModelRef {
  const ref = modelRef("RUNNER_VISITOR_MODEL", "meta/muse-spark-1.3");
  if (!isVisitorSafe(ref)) {
    throw new Error(
      `RUNNER_VISITOR_MODEL must be a Standard-mode meta/ model, got "${ref.provider}/${ref.id}"`,
    );
  }
  return ref;
}

/** Whether a visitor's Meta key and scan may go to this model (see `visitorModel`). */
export const isVisitorSafe = (ref: ModelRef) =>
  ref.provider === "meta" && !ref.id.endsWith("-contributor");

/**
 * The aliases an agent definition's `model:` may name, to `provider/id`: the defaults here,
 * and `RUNNER_MODEL_ALIASES` (a JSON object of alias to `provider/id`) adds or overrides.
 * Changing a model for every workflow means changing this table, not the package.
 */
function modelAliases(): Record<string, ModelRef> {
  const table: Record<string, string> = {
    "muse-wonder": "meta/muse-wonder-1.0",
    "muse-spark": "meta/muse-spark-1.3",
    ...JSON.parse(optional("RUNNER_MODEL_ALIASES") ?? "{}"),
  };
  return Object.fromEntries(
    Object.entries(table).map(([alias, text]) => {
      const [provider, ...rest] = String(text).split("/");
      if (!provider || rest.length === 0) {
        throw new Error(
          `RUNNER_MODEL_ALIASES: "${alias}" must be provider/model-id, got "${text}"`,
        );
      }
      return [alias, { provider, id: rest.join("/") }];
    }),
  );
}

/** Our key for a provider, if set (`VOLUMA_<PROVIDER>_API_KEY`). */
export const providerKey = (provider: string) =>
  optional(`VOLUMA_${provider.toUpperCase()}_API_KEY`);

/** Our Modal token; absent: the SDK uses ~/.modal.toml. */
export function modalToken(): { tokenId: string; tokenSecret: string } | undefined {
  const tokenId = optional("MODAL_TOKEN_ID");
  const tokenSecret = optional("MODAL_TOKEN_SECRET");
  return tokenId && tokenSecret ? { tokenId, tokenSecret } : undefined;
}

export type Config = ReturnType<typeof runnerConfig>;

export function runnerConfig() {
  const modal = modalToken();
  const ref = modelRef("RUNNER_MODEL");
  const model = { ...ref, apiKey: required(`VOLUMA_${ref.provider.toUpperCase()}_API_KEY`) };
  const api = apiEndpoint();
  const r2 = {
    accountId: required("R2_ACCOUNT_ID"),
    bucket: required("R2_BUCKET"),
    accessKeyId: required("R2_ACCESS_KEY_ID"),
    secretAccessKey: required("R2_SECRET_ACCESS_KEY"),
    cloudflareApiToken: required("CLOUDFLARE_API_TOKEN"),
  };
  return {
    api,
    /** Runs at once. */
    concurrency: positiveInt("RUNNER_CONCURRENCY", 2),
    /** The model of a `voluma` run, with our key for its provider (`VOLUMA_<PROVIDER>_API_KEY`). */
    model,
    /**
     * The model of a `visitor` run, which uses the visitor's Meta key. Standard mode: a
     * `-contributor` model lets Meta train on what it is sent, the visitor's scan included.
     */
    visitorModel: visitorModel(),
    /** Aliases a workflow's agents name for their model, resolved when a run starts. */
    aliases: modelAliases(),
    modal,
    r2,
    /** For importing workflow packages from private GitHub repos. */
    githubToken: optional("GITHUB_TOKEN"),
    /** Every secret of ours, to redact from anything that leaves the process. */
    secrets: [
      api.token,
      ...["anthropic", "meta", "openai"].map(providerKey),
      r2.accessKeyId,
      r2.secretAccessKey,
      r2.cloudflareApiToken,
      optional("GITHUB_TOKEN"),
      modal?.tokenId,
      modal?.tokenSecret,
    ].filter((s): s is string => s !== undefined),
    sandbox: {
      image: optional("VOLUMA_SANDBOX_IMAGE") ?? "voluma-microct",
      lifetimeSeconds: positiveInt("VOLUMA_SANDBOX_LIFETIME_SECONDS", 3600),
      // The floor keeps a sandbox from idling out before its inputs finish staging.
      idleSeconds: positiveInt("VOLUMA_SANDBOX_IDLE_SECONDS", 300, 30),
    },
  };
}
