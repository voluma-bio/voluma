/**
 * `pnpm dev:stop`: stops the dev processes this worktree started through `tools/dev-run.mjs`
 * (`pnpm dev`, the runner's `start` and `try-run`) and nothing else. Each is a process group
 * recorded in `.dev/pids/`: SIGTERM, a few seconds' wait, then SIGKILL for what is left. A group
 * is signalled only if its leader is alive with its cwd inside this worktree, so a recycled PID
 * is never hit. Processes in this worktree that were not recorded are listed, not stopped.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync } from "node:fs";
import { resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const root = realpathSync(resolve(import.meta.dirname, ".."));
const pidsDir = resolve(root, ".dev/pids");
const GRACE_MS = 5000;

if (process.argv.length > 2) {
  console.error("dev:stop takes no arguments: it stops this worktree's recorded processes.");
  process.exit(1);
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
};
const groupAlive = (pgid) => alive(-pgid);
const signalGroup = (pgid, signal) => {
  try {
    process.kill(-pgid, signal);
  } catch {}
};

function cwdOf(pid) {
  try {
    if (process.platform === "linux") return readlinkSync(`/proc/${pid}/cwd`);
    const out = execFileSync("lsof", ["-p", String(pid), "-a", "-d", "cwd", "-Fn"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out
      .split("\n")
      .find((line) => line.startsWith("n"))
      ?.slice(1);
  } catch {
    return undefined;
  }
}
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
  if (alive(entry.pgid) && inWorktree(cwdOf(entry.pgid))) targets.push({ file, path, ...entry });
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
const ppidOf = (pid) =>
  Number(execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8" }).trim());
const ancestors = new Set();
for (let pid = process.pid; pid > 1 && !ancestors.has(pid); ) {
  ancestors.add(pid);
  try {
    pid = ppidOf(pid);
  } catch {
    break;
  }
}
const pids =
  process.platform === "linux"
    ? readdirSync("/proc").filter((n) => /^\d+$/.test(n))
    : execFileSync("ps", ["-axo", "pid="], { encoding: "utf8" }).trim().split(/\s+/);
const command = (pid) => {
  try {
    return execFileSync("ps", ["-o", "args=", "-p", String(pid)], { encoding: "utf8" }).trim();
  } catch {
    return undefined; // exited since the scan
  }
};
const others = pids
  .map(Number)
  .filter((pid) => !ancestors.has(pid) && inWorktree(cwdOf(pid)))
  .flatMap((pid) => {
    const args = command(pid);
    return args ? [`  ${pid}  ${args}`] : [];
  });
if (others.length > 0) {
  console.log(
    `\nstill running in this worktree, not recorded (stop by PID if they are yours):\n${others.join("\n")}`,
  );
}
