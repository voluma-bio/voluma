/**
 * The runner's settings: the repo's `.env` (or the file `VOLUMA_ENV_FILE` names) if there
 * is one, over which the process environment (Railway's variables) takes precedence. Read
 * into a plain object, never written to `process.env`, so keys are not inherited by child
 * processes or picked up by other libraries; callers pass each one on explicitly.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import { modelRefSchema } from "@voluma/contracts/ids";
import { PROVIDERS } from "./providers.ts";

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

function optionalPositiveNumber(name: string): number | undefined {
  const raw = optional(name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
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
export type ModelRef = { provider: string; id: string };
function modelRef(name: string, fallback?: string): ModelRef {
  const text = fallback ? (optional(name) ?? fallback) : required(name);
  const [provider, ...rest] = text.split("/");
  const id = rest.join("/");
  // The form `thread.started.model` takes: a role's model is recorded on its threads.
  if (!provider || !id || !modelRefSchema.safeParse(text).success) {
    throw new Error(`${name} must be provider/model-id, got "${text}"`);
  }
  return { provider, id };
}

/** The aliases a role file may name, with the model each takes when its variable is unset. */
const MODEL_ALIASES: Record<string, string | undefined> = {
  wonder: "meta/muse-wonder-1.0",
  opus: undefined,
  astra: undefined,
};

/**
 * The model of each alias: `RUNNER_MODEL_<ALIAS>`, else the alias's default, else the alias is
 * absent (a run whose role file names it fails when it starts). `RUNNER_MODEL`, when set, forces
 * every alias to one model (a plumbing check on a cheap provider).
 */
function modelAliases(): Record<string, ModelRef> {
  const forced = optional("RUNNER_MODEL") ? modelRef("RUNNER_MODEL") : undefined;
  const models: Record<string, ModelRef> = {};
  for (const [alias, fallback] of Object.entries(MODEL_ALIASES)) {
    const name = `RUNNER_MODEL_${alias.toUpperCase()}`;
    if (forced) models[alias] = forced;
    else if (fallback || optional(name)) models[alias] = modelRef(name, fallback);
  }
  return models;
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

/** Our key for a provider, if set (`VOLUMA_<PROVIDER>_API_KEY`). */
export const providerKey = (provider: string) =>
  optional(`VOLUMA_${provider.toUpperCase()}_API_KEY`);

/** Our Modal token; absent: the SDK uses ~/.modal.toml. */
export function modalToken(): { tokenId: string; tokenSecret: string } | undefined {
  const tokenId = optional("MODAL_TOKEN_ID");
  const tokenSecret = optional("MODAL_TOKEN_SECRET");
  return tokenId && tokenSecret ? { tokenId, tokenSecret } : undefined;
}

/**
 * The public sandbox image every run uses, pinned by digest (built from
 * sandbox/Dockerfile by the "Sandbox image" workflow, which prints the new digest).
 */
const SANDBOX_IMAGE =
  "ghcr.io/voluma-bio/voluma-sandbox@sha256:00ee4e57a712f19b44e4ead17572083f558e31c229d396778dbbe04d33d525d1";

/**
 * The commit this runner's checkout is at, which a run records as the source of its workflow
 * files: Railway's (the build has no `.git`), else the checkout's (`pnpm dev`; uncommitted edits
 * to `workflows/` are not in it).
 */
function checkoutCommit(): string {
  const sha =
    optional("RAILWAY_GIT_COMMIT_SHA") ??
    execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`the checkout's commit is not a SHA: ${sha}`);
  return sha;
}

export type Config = ReturnType<typeof runnerConfig>;

export function runnerConfig() {
  const modal = modalToken();
  const models = modelAliases();
  // Off unless set: lab data goes to Standard-mode Meta models by default, so a fallback to
  // another provider is a per-deploy choice (see model-fallback.ts).
  const fallbackModel = optional("RUNNER_FALLBACK_MODEL")
    ? modelRef("RUNNER_FALLBACK_MODEL")
    : undefined;
  if (fallbackModel) {
    required(`VOLUMA_${fallbackModel.provider.toUpperCase()}_API_KEY`);
    if (fallbackModel.provider === "meta" && fallbackModel.id.endsWith("-contributor")) {
      throw new Error(
        "RUNNER_FALLBACK_MODEL must not be a -contributor model: Meta may train on lab data",
      );
    }
  }
  for (const { provider } of Object.values(models))
    required(`VOLUMA_${provider.toUpperCase()}_API_KEY`);
  const api = apiEndpoint();
  const metaApiKey = optional("VOLUMA_META_API_KEY");
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
    /**
     * A run whose spend (all claims, gateway calls included) reaches this is stopped and ends
     * `failed`. Unset: no cap (test runs have none). Sent with every claim when set: the gateway
     * checks the same cap. A SAM call reserves $3 there, so the cap must leave room for it.
     */
    maxRunCostUsd: optionalPositiveNumber("RUNNER_MAX_RUN_COST_USD"),
    /** The run loop's limits (`LoopConfig`); the harness defaults are 2 fix rounds and 20 minutes. */
    loop: {
      maxFixRounds: positiveInt("RUNNER_MAX_FIX_ROUNDS", 2),
      checkTimeoutMs: positiveInt("RUNNER_CHECK_TIMEOUT_MINUTES", 20) * 60_000,
    },
    /**
     * The model behind each alias a role file may name (`model:` in `workflows/core/agents/`),
     * for a `voluma` run. Our key for each provider is `VOLUMA_<PROVIDER>_API_KEY`.
     */
    models,
    /** Where new worker and check threads go while their model is failing; absent: nowhere. */
    fallbackModel,
    /**
     * The model of a `visitor` run, which uses the visitor's Meta key. Standard mode: a
     * `-contributor` model lets Meta train on what it is sent, the visitor's scan included.
     */
    visitorModel: visitorModel(),
    modal,
    /** Meta's key for SAM (`segment_sam`) on a `voluma` run; absent: the tool is not offered. A visitor's run uses the visitor's own key. */
    metaApiKey,
    r2,
    commit: checkoutCommit(),
    /** Every secret of ours, to redact from anything that leaves the process. */
    secrets: [
      api.token,
      ...Object.keys(PROVIDERS).map(providerKey),
      r2.accessKeyId,
      r2.secretAccessKey,
      r2.cloudflareApiToken,
      metaApiKey,
      modal?.tokenId,
      modal?.tokenSecret,
    ].filter((s): s is string => s !== undefined),
    sandbox: {
      image: SANDBOX_IMAGE,
      lifetimeSeconds: positiveInt("VOLUMA_SANDBOX_LIFETIME_SECONDS", 14400),
      // The floor keeps a sandbox from idling out before its inputs finish staging.
      idleSeconds: positiveInt("VOLUMA_SANDBOX_IDLE_SECONDS", 300, 30),
    },
  };
}
