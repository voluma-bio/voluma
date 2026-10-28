/**
 * The runner's settings, read from the repo's `.env` (or the file `VOLUMA_ENV_FILE` names)
 * into a plain object. Nothing is written to `process.env`, so keys are never inherited
 * by child processes or picked up by other libraries; callers pass each one on explicitly.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";

const file = process.env.VOLUMA_ENV_FILE ?? resolve(import.meta.dirname, "../../../.env");
const values = parseEnv(readFileSync(file, "utf8"));

/** A setting that may be empty or absent. */
export const optional = (name: string): string | undefined => values[name] || undefined;

/** A setting that must be set. */
export function required(name: string): string {
  const value = optional(name);
  if (!value) throw new Error(`${name} is not set in ${file}`);
  return value;
}

/**
 * The local API `pnpm dev` started in this worktree (tools/dev.mjs writes `.dev/env.json`).
 * Used when VOLUMA_API_URL is unset; throws if the launcher has not run.
 */
export function localApi(): { baseUrl: string; token: string } {
  const path = resolve(import.meta.dirname, "../../../.dev/env.json");
  try {
    const { apiUrl, apiToken } = JSON.parse(readFileSync(path, "utf8"));
    return { baseUrl: apiUrl, token: apiToken };
  } catch {
    throw new Error(`VOLUMA_API_URL is not set and ${path} is missing: run \`pnpm dev\` first`);
  }
}
