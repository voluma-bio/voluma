/**
 * `pnpm worktrees:clean [--yes]`: removes the worktrees under ../voluma.worktrees that are done,
 * with their branch, their dev servers and their `pnpm dev` database. Without --yes it only lists.
 *
 * Done: no uncommitted changes to tracked files, and the branch's PR is merged or closed, or the
 * branch has no PR, nothing beyond origin/main, and no commit for a day. Anything else is kept.
 * Also stops dev servers still running in worktree folders that no longer exist, and drops the
 * `voluma_<slug>_<hash>` databases whose worktree is gone (names without a hash were made by hand
 * and are only listed).
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readlinkSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import postgres from "postgres";

const yes = process.argv.includes("--yes");
// The primary checkout holds the shared .git, so this works from any worktree.
const primary = dirname(
  execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
    cwd: import.meta.dirname,
    encoding: "utf8",
  }).trim(),
);
const parent = resolve(primary, "../voluma.worktrees");
const git = (...args) => execFileSync("git", ["-C", primary, ...args], { encoding: "utf8" }).trim();
const say = (line) => console.log(`${yes ? "" : "[dry run] "}${line}`);

// Same name `tools/dev.mjs` gives a checkout's database.
const dbName = (root) =>
  `voluma_${basename(root)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .slice(0, 40)}_${createHash("sha256").update(root).digest("hex").slice(0, 8)}`;

/** pid → cwd for every process whose cwd is under the worktrees folder (deleted folders too). */
function processesUnder(dir) {
  const found = [];
  for (const pid of readdirSync("/proc").filter((p) => /^\d+$/.test(p))) {
    try {
      const cwd = readlinkSync(`/proc/${pid}/cwd`).replace(/ \(deleted\)$/, "");
      if (cwd === dir || cwd.startsWith(`${dir}/`)) found.push({ pid: Number(pid), cwd });
    } catch {}
  }
  return found;
}

/** SIGTERM, then SIGKILL whatever is still running 3 s later (wrangler ignores SIGTERM). */
async function stop(pids) {
  const signal = (pid, sig) => {
    try {
      process.kill(pid, sig);
    } catch {}
  };
  for (const pid of pids) signal(pid, "SIGTERM");
  if (pids.length) await new Promise((done) => setTimeout(done, 3000));
  for (const pid of pids) signal(pid, "SIGKILL");
}

function prState(branch) {
  try {
    const out = execFileSync(
      "gh",
      ["pr", "list", "--head", branch, "--state", "all", "--json", "state", "--jq", ".[0].state"],
      { cwd: primary, encoding: "utf8" },
    ).trim();
    return out || "NONE";
  } catch {
    return "UNKNOWN";
  }
}

git("fetch", "-q", "--prune", "origin");
const all = git("worktree", "list", "--porcelain")
  .split("\n\n")
  .map((block) => ({
    path: block.match(/^worktree (.+)$/m)?.[1],
    branch: block.match(/^branch refs\/heads\/(.+)$/m)?.[1],
  }));
const worktrees = all.filter((w) => w.path?.startsWith(`${parent}/`));
// Every checkout this script doesn't remove keeps its database, wherever it lives.
const kept = all.filter((w) => w.path && !worktrees.includes(w)).map((w) => w.path);
for (const { path, branch } of worktrees) {
  const dirty = git("-C", path, "status", "--porcelain", "--untracked-files=no") !== "";
  const pr = branch ? prState(branch) : "DETACHED";
  const ahead = branch ? Number(git("rev-list", "--count", `origin/main..${branch}`)) : 1;
  const lastCommit = Number(git("-C", path, "log", "-1", "--format=%ct")) * 1000;
  const idle = Date.now() - lastCommit > 24 * 3600 * 1000;
  const done =
    !dirty && (pr === "MERGED" || pr === "CLOSED" || (pr === "NONE" && ahead === 0 && idle));
  if (!done) {
    kept.push(path);
    console.log(
      `keep ${basename(path)} (${branch}: PR ${pr}${dirty ? ", uncommitted changes" : ""})`,
    );
    continue;
  }
  say(`remove ${basename(path)} (${branch}: PR ${pr})`);
  if (!yes) continue;
  await stop(processesUnder(path).map((p) => p.pid));
  git("worktree", "remove", "--force", path);
  // -D: a closed PR's branch is not merged; its commits stay on GitHub with the PR.
  if (branch) git("branch", "-D", branch);
}
if (yes) git("worktree", "prune");

const orphans = processesUnder(parent).filter(({ cwd }) => !existsSync(cwd));
for (const { pid, cwd } of orphans) say(`stop pid ${pid}, running in deleted ${cwd}`);
if (yes) await stop(orphans.map((p) => p.pid));

const sql = postgres("postgres://voluma:voluma@localhost:54432/postgres", { onnotice: () => {} });
try {
  const keep = new Set(kept.map(dbName));
  const names = (await sql`select datname from pg_database where datname like 'voluma\\_%'`).map(
    (r) => r.datname,
  );
  for (const name of names) {
    if (keep.has(name)) continue;
    if (!/_[0-9a-f]{8}$/.test(name)) {
      console.log(`left alone: database ${name} (made by hand)`);
      continue;
    }
    say(`drop database ${name}`);
    if (yes) await sql.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  }
} catch (error) {
  console.log(`databases skipped: ${error.message} (is \`pnpm db:up\` running?)`);
} finally {
  await sql.end();
}
