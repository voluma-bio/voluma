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
  if (baseUrl && token) return { baseUrl, token };
  const path = resolve(import.meta.dirname, "../../../.dev/env.json");
  try {
    const { apiUrl, apiToken } = JSON.parse(readFileSync(path, "utf8"));
    return { baseUrl: apiUrl, token: apiToken };
  } catch {
    throw new Error(`set VOLUMA_API_URL and VOLUMA_API_TOKEN, or run \`pnpm dev\` (${path})`);
  }
}

/** A model as `provider/id`, e.g. `openai/gpt-5.6-luna`. */
function modelRef(name: string, fallback?: string): { provider: string; id: string } {
  const text = fallback ? (optional(name) ?? fallback) : required(name);
  const [provider, ...rest] = text.split("/");
  const id = rest.join("/");
  if (!provider || !id) throw new Error(`${name} must be provider/model-id, got "${text}"`);
  return { provider, id };
}

export type Config = ReturnType<typeof runnerConfig>;

export function runnerConfig() {
  const modalTokenId = optional("MODAL_TOKEN_ID");
  const modalTokenSecret = optional("MODAL_TOKEN_SECRET");
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
    /** The model of a `voluma` run, whose key is ours. */
    model: modelRef("RUNNER_MODEL"),
    /** The model of a `visitor` run, which uses the visitor's Meta key. */
    visitorModel: modelRef("RUNNER_VISITOR_MODEL", "meta/muse-spark-1.3-contributor"),
    /** Our model keys by provider, from `VOLUMA_<PROVIDER>_API_KEY`. */
    modelKey: (provider: string) => required(`VOLUMA_${provider.toUpperCase()}_API_KEY`),
    /** Our Modal token; absent: the SDK uses ~/.modal.toml. */
    modal:
      modalTokenId && modalTokenSecret
        ? { tokenId: modalTokenId, tokenSecret: modalTokenSecret }
        : undefined,
    r2,
    /** Every secret of ours, to redact from anything that leaves the process. */
    secrets: [
      api.token,
      r2.accessKeyId,
      r2.secretAccessKey,
      r2.cloudflareApiToken,
      modalTokenId,
      modalTokenSecret,
      ...["OPENAI", "META", "ANTHROPIC"].map((p) => optional(`VOLUMA_${p}_API_KEY`)),
    ].filter((s): s is string => s !== undefined),
    sandbox: {
      image: optional("VOLUMA_SANDBOX_IMAGE") ?? "voluma-microct",
      lifetimeSeconds: positiveInt("VOLUMA_SANDBOX_LIFETIME_SECONDS", 3600),
      // The floor keeps a sandbox from idling out before its inputs finish staging.
      idleSeconds: positiveInt("VOLUMA_SANDBOX_IDLE_SECONDS", 300, 30),
    },
  };
}
