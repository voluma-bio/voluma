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
