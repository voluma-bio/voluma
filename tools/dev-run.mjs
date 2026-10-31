/**
 * `node tools/dev-run.mjs <label> <command> [args…]`: runs a long-lived dev command (`pnpm dev`,
 * the runner's `start` and `try-run`) in its own process group and records that group in this
 * worktree's git-ignored `.dev/pids/`, so `pnpm dev:stop` can stop exactly it and its children.
 * Signals sent to this wrapper are forwarded to the group; the entry is removed when the group
 * ends. An entry left by a killed wrapper is cleaned up by `dev:stop`.
 */
import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { constants } from "node:os";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { identity } from "./dev-proc.mjs";

const [label, command, ...args] = process.argv.slice(2);
if (!label || !command) {
  console.error("usage: node tools/dev-run.mjs <label> <command> [args…]");
  process.exit(2);
}

const pidsDir = resolve(import.meta.dirname, "../.dev/pids");
mkdirSync(pidsDir, { recursive: true });

const child = spawn(command, args, { stdio: "inherit", detached: true });
const entry = resolve(pidsDir, `${label}.${child.pid}`);
writeFileSync(entry, `${JSON.stringify({ pgid: child.pid, identity: identity(child.pid) })}\n`);

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => signalGroup(signal));
}
child.on("error", (error) => {
  rmSync(entry, { force: true });
  console.error(error.message);
  process.exit(2);
});
child.on("exit", async (code, signal) => {
  // The leader can exit before its children (dev.mjs gives them 500 ms): keep the entry, and
  // end what is left, until the group is empty.
  for (let waited = 0; groupAlive(); waited += 100) {
    if (waited === 0) signalGroup("SIGTERM");
    if (waited === 5000) signalGroup("SIGKILL");
    await delay(100);
  }
  rmSync(entry, { force: true });
  process.exit(code ?? 128 + constants.signals[signal]);
});
function groupAlive() {
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch {
    return false;
  }
}
function signalGroup(signal) {
  try {
    process.kill(-child.pid, signal);
  } catch {}
}
