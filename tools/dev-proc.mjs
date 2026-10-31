/** Process lookups shared by `dev-run.mjs` (records a group) and `dev-stop.mjs` (checks it). */
import { execFileSync } from "node:child_process";
import { readdirSync, readlinkSync } from "node:fs";

const ps = (field, pid) => {
  try {
    return execFileSync("ps", ["-o", `${field}=`, "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined; // no such process
  }
};

/** Group id and start time: the pair tells a recorded leader from a later process with its PID. */
export const identity = (pid) => {
  const [pgid, started] = [ps("pgid", pid), ps("lstart", pid)];
  return pgid && started ? `${pgid} ${started}` : undefined;
};
export const parentOf = (pid) => Number(ps("ppid", pid));
export const command = (pid) => ps("args", pid);

/** Every visible process's cwd. One `lsof` call on macOS: it takes ~0.4 s per process id. */
export function cwds() {
  const found = new Map();
  if (process.platform === "linux") {
    for (const name of readdirSync("/proc").filter((n) => /^\d+$/.test(n))) {
      try {
        found.set(Number(name), readlinkSync(`/proc/${name}/cwd`));
      } catch {} // exited, or not ours to read
    }
    return found;
  }
  let pid;
  const out = execFileSync("lsof", ["-a", "-d", "cwd", "-Fpn"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: 64 << 20,
  }).split("\n");
  for (const line of out) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n") && pid !== undefined) found.set(pid, line.slice(1));
  }
  return found;
}
