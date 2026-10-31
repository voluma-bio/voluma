/**
 * `node tools/dev-run.mjs <label> <command> [args…]`: runs a long-lived dev command (`pnpm dev`,
 * the runner's `start` and `try-run`) in its own process group and records that group in this
 * worktree's git-ignored `.dev/pids/`, so `pnpm dev:stop` can stop exactly it and its children.
 * Signals sent to this wrapper are forwarded to the group; the entry is removed when the group
 * ends. An entry left by a killed wrapper is cleaned up by `dev:stop`.
 */
import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const [label, command, ...args] = process.argv.slice(2);
if (!label || !command) {
  console.error("usage: node tools/dev-run.mjs <label> <command> [args…]");
  process.exit(2);
}

const pidsDir = resolve(import.meta.dirname, "../.dev/pids");
mkdirSync(pidsDir, { recursive: true });

const child = spawn(command, args, { stdio: "inherit", detached: true });
const entry = resolve(pidsDir, `${label}.${child.pid}`);
writeFileSync(entry, `${JSON.stringify({ pgid: child.pid, wrapper: process.pid })}\n`);

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    try {
      process.kill(-child.pid, signal);
    } catch {}
  });
}
child.on("error", (error) => {
  rmSync(entry, { force: true });
  console.error(error.message);
  process.exit(2);
});
child.on("exit", (code, signal) => {
  rmSync(entry, { force: true });
  process.exit(code ?? 128 + (signal === "SIGINT" ? 2 : 15));
});
