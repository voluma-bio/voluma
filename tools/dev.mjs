/**
 * `pnpm dev`: the one dev launcher. Starts the API and the web app for this worktree
 * without sharing anything with other worktrees:
 *  - two free ports, picked up front (the API's, and Vite's with --strictPort);
 *  - a database named after the worktree directory and a hash of its path
 *    (`voluma_<dir>_<hash8>`), created on the Postgres server in DATABASE_SERVER_URL
 *    (`pnpm db:up` starts one) and migrated;
 *  - a random API token per launch.
 * The API also reads the repo .env (--env-file-if-exists), as it would read Railway's
 * variables. It writes { apiUrl, apiToken } to the git-ignored .dev/env.json, which
 * the runner reads when VOLUMA_API_URL is unset. Ctrl-C stops everything
 * and removes it.
 * `pnpm db:reset` (`node tools/dev.mjs reset`) drops this worktree's database and exits;
 * the next `pnpm dev` recreates and migrates it.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { basename, resolve } from "node:path";
import { parseEnv } from "node:util";
import postgres from "postgres";

const root = resolve(import.meta.dirname, "..");
const envFile = resolve(root, ".env");
const dotenv = existsSync(envFile) ? parseEnv(readFileSync(envFile, "utf8")) : {};

const serverUrl = new URL(
  process.env.DATABASE_SERVER_URL ||
    dotenv.DATABASE_SERVER_URL ||
    "postgres://voluma:voluma@localhost:54432/postgres",
);
// The slug tells databases apart for a person; the hash keeps clones that share a
// basename (or fold to the same slug) apart.
const slug = basename(root)
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, "_")
  .slice(0, 40);
const dbName = `voluma_${slug}_${createHash("sha256").update(root).digest("hex").slice(0, 8)}`;
const databaseUrl = new URL(serverUrl);
databaseUrl.pathname = `/${dbName}`;

if (process.argv[2] === "reset") {
  await withAdmin(async (admin) => {
    // dbName is [a-z0-9_] only, so quoting it is enough.
    await admin.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  });
  console.log(`dropped ${dbName}; \`pnpm dev\` recreates it`);
  process.exit(0);
}
await ensureDatabase();

const [apiPort, webPort] = [await freePort(), await freePort()];
const appUrl = `http://localhost:${webPort}`;
const env = {
  apiUrl: `http://localhost:${apiPort}`,
  apiToken: randomBytes(24).toString("hex"),
};
const envPath = resolve(root, ".dev/env.json");
mkdirSync(resolve(root, ".dev"), { recursive: true });
writeFileSync(envPath, `${JSON.stringify(env, null, 2)}\n`);

const migrate = spawnSync("pnpm", ["--filter", "@voluma/api", "db:migrate"], {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, DATABASE_URL: databaseUrl.href },
});
if (migrate.status !== 0) {
  console.error(
    "\nMigration failed. If you regenerated a migration after merging origin/main, this\ndatabase still holds the old one: run `pnpm db:reset`, then `pnpm dev`.",
  );
  rmSync(envPath, { force: true });
  process.exit(migrate.status ?? 1);
}

console.log(`\nweb  ${appUrl}\napi  ${env.apiUrl}\ndb   ${dbName}\n`);
const children = [
  spawn("node", ["--env-file-if-exists", envFile, "--import", "tsx", "--watch", "src/index.ts"], {
    cwd: resolve(root, "apps/api"),
    stdio: "inherit",
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl.href,
      VOLUMA_API_TOKEN: env.apiToken,
      PORT: String(apiPort),
      HOST: "127.0.0.1",
    },
  }),
  spawn(
    "pnpm",
    ["--filter", "@voluma/web", "exec", "vite", "--port", String(webPort), "--strictPort"],
    {
      cwd: root,
      stdio: "inherit",
      env: { ...process.env, VOLUMA_API_URL: env.apiUrl },
    },
  ),
];
for (const child of children) {
  child.on("exit", () => stop(1));
}
process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));
function stop(code) {
  rmSync(envPath, { force: true });
  for (const child of children) child.kill("SIGTERM");
  setTimeout(() => process.exit(code), 500).unref();
}

function ensureDatabase() {
  return withAdmin(async (admin) => {
    const found = await admin`SELECT 1 FROM pg_database WHERE datname = ${dbName}`;
    if (found.length === 0) await admin.unsafe(`CREATE DATABASE "${dbName}"`);
  });
}

async function withAdmin(run) {
  const admin = postgres(serverUrl.href, { max: 1, onnotice: () => {} });
  try {
    await run(admin);
  } catch (error) {
    if (!isConnectionError(error)) throw error;
    console.error(
      `Cannot reach Postgres at ${serverUrl.host}: ${error.message || error.code}\nStart it with \`pnpm db:up\`, or set DATABASE_SERVER_URL in .env.`,
    );
    process.exit(1);
  } finally {
    await admin.end();
  }
}

// Refused or unresolved host, bad credentials, no such database.
function isConnectionError(error) {
  return ["ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT", "28P01", "3D000"].includes(error.code);
}

function freePort() {
  return new Promise((done, fail) => {
    const server = createServer()
      .unref()
      .listen(0, "127.0.0.1", () => {
        const { port } = server.address();
        server.close(() => done(port));
      })
      .on("error", fail);
  });
}
