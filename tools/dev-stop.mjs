/**
 * `pnpm dev:stop`: stops the dev processes this worktree started through `tools/dev-run.mjs`
 * (`pnpm dev`, the runner's `start` and `try-run`) and nothing else. Each is a process group
 * recorded in `.dev/pids/`: SIGTERM, a few seconds' wait, then SIGKILL for what is left. A group
 * is signalled only if its leader is alive with its cwd inside this worktree, so a recycled PID
 * is never hit. Processes in this worktree that were not recorded are listed, not stopped.
 */
import { existsSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { command, cwds as cwdMap, identity, parentOf } from "./dev-proc.mjs";

const root = realpathSync(resolve(import.meta.dirname, ".."));
const pidsDir = resolve(root, ".dev/pids");
// A runner releases its runs on SIGTERM within 50 s (apps/runner/src/main.ts); SIGKILL earlier would lose the release.
const GRACE_MS = 55_000;

if (process.argv.length > 2) {
  console.error("dev:stop takes no arguments: it stops this worktree's recorded processes.");
  process.exit(1);
}

const groupAlive = (pgid) => {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
};
const signalGroup = (pgid, signal) => {
  try {
    process.kill(-pgid, signal);
  } catch {}
};

const cwds = cwdMap();
const inWorktree = (cwd) => cwd !== undefined && (cwd === root || cwd.startsWith(root + sep));

const stale = [];
const targets = [];
const recorded = existsSync(pidsDir) ? readdirSync(pidsDir) : [];
for (const file of recorded) {
  const path = resolve(pidsDir, file);
  let entry;
  try {
    entry = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    rmSync(path, { force: true });
    continue;
  }
  if (identity(entry.pgid) === entry.identity && inWorktree(cwds.get(entry.pgid)))
    targets.push({ file, path, ...entry });
  else {
    rmSync(path, { force: true });
    stale.push(file);
  }
}

for (const t of targets) signalGroup(t.pgid, "SIGTERM");
const deadline = Date.now() + GRACE_MS;
while (targets.some((t) => groupAlive(t.pgid)) && Date.now() < deadline) await delay(100);
for (const t of targets) {
  const killed = groupAlive(t.pgid);
  if (killed) signalGroup(t.pgid, "SIGKILL");
  rmSync(t.path, { force: true });
  console.log(`stopped ${t.file} (group ${t.pgid}${killed ? ", needed SIGKILL" : ""})`);
}
for (const file of stale) console.log(`skipped ${file}: not running here (entry removed)`);
if (targets.length + stale.length === 0) console.log("no recorded dev processes");

// Anything else in this worktree: not ours to stop. Skip this command and its ancestors.
const ancestors = new Set();
for (let pid = process.pid; pid > 1 && !ancestors.has(pid); pid = parentOf(pid)) {
  ancestors.add(pid);
}
const others = [...cwdMap()]
  .filter(([pid, cwd]) => !ancestors.has(pid) && inWorktree(cwd))
  .flatMap(([pid]) => {
    const args = command(pid);
    return args ? [`  ${pid}  ${args}`] : []; // none: exited since the scan
  });
if (others.length > 0) {
  console.log(`\nstill running in this worktree, not recorded:\n${others.join("\n")}`);
}
