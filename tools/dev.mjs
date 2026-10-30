/**
 * `pnpm dev`: the one dev launcher. Starts the API and the web app for this worktree
 * without sharing anything with other worktrees:
 *  - two free ports (the API's, and Vite's with --strictPort), or Amp's allocated
 *    PORT for Vite when a portal supplies PUBLIC_URL;
 *  - a database named after the worktree directory and a hash of its path
 *    (`voluma_<dir>_<hash8>`), created on the Postgres server in DATABASE_SERVER_URL
 *    (`pnpm db:up` starts one) and migrated;
 *  - a random API token per launch;
 *  - APP_URL, the Vite origin, which the API uses for the sign-in redirect and the Origin check.
 *    PUBLIC_URL supplies the external origin in a supervised Amp portal.
 * The API also reads the repo .env (--env-file-if-exists), as it would read the host's
 * variables. It writes { apiUrl, apiToken, appUrl, databaseUrl } to the git-ignored .dev/env.json, which
 * the runner reads when VOLUMA_API_URL is unset and the API's operator scripts read when
 * DATABASE_URL is unset. Ctrl-C stops everything
 * and removes it.
 * With VOLUMA_META_API_KEY set it also starts the provider gateway on a free port (same database,
 * a random GATEWAY_TOKEN_SECRET per launch) and opens a Cloudflare quick tunnel to it: worker
 * sandboxes run on Modal and can reach only an https host, never localhost. The tunnel's URL and
 * the secret join env.json as { gatewayUrl, gatewaySecret }, which the runner reads when its own
 * VOLUMA_GATEWAY_URL is unset. Without the tunnel (no key, or cloudflared can't start) there is no
 * gateway URL: runs work except `segment_sam`, which is not offered.
 * `pnpm db:reset` (`node tools/dev.mjs reset`) drops this worktree's database and exits;
 * the next `pnpm dev` recreates and migrates it.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
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

const [apiPort, webPort] = [
  await freePort(),
  process.env.PUBLIC_URL ? Number(process.env.PORT) : await freePort(),
];
const appUrl = new URL(process.env.PUBLIC_URL ?? `http://localhost:${webPort}`).origin;
const metaKey = process.env.VOLUMA_META_API_KEY || dotenv.VOLUMA_META_API_KEY;
const gatewayPort = metaKey ? await freePort() : undefined;
const env = {
  apiUrl: `http://localhost:${apiPort}`,
  apiToken: randomBytes(24).toString("hex"),
  appUrl,
  databaseUrl: databaseUrl.href,
  ...(gatewayPort && { gatewaySecret: `dev:${randomBytes(32).toString("base64")}` }),
};
const envPath = resolve(root, ".dev/env.json");
mkdirSync(resolve(root, ".dev"), { recursive: true });
const writeEnv = () => writeFileSync(envPath, `${JSON.stringify(env, null, 2)}\n`);
writeEnv();

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
      APP_URL: appUrl,
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
      env: {
        ...process.env,
        VOLUMA_API_URL: env.apiUrl,
        __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS: new URL(appUrl).hostname,
      },
    },
  ),
];
if (gatewayPort) {
  children.push(
    spawn("node", ["--import", "tsx", "src/main.ts"], {
      cwd: resolve(root, "apps/gateway"),
      stdio: "inherit",
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl.href,
        GATEWAY_TOKEN_SECRET: env.gatewaySecret,
        GATEWAY_META_API_KEY: metaKey,
        PORT: String(gatewayPort),
      },
    }),
  );
}
let tunnel;
let stopping = false;
for (const child of children) {
  child.on("exit", () => stop(1));
}
tunnel = gatewayPort ? await openGatewayTunnel(gatewayPort) : undefined;
if (!gatewayPort) {
  console.log("gateway off: set VOLUMA_META_API_KEY in .env for segment_sam in local runs\n");
}
process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));
function stop(code) {
  stopping = true;
  rmSync(envPath, { force: true });
  tunnel?.stop();
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

/**
 * A Cloudflare quick tunnel (no account) to the local gateway, so a Modal sandbox can reach it.
 * The binary is downloaded once into ~/.cache/voluma, shared by all worktrees. Gateway token
 * auth stays on: the URL is public. Any failure only turns the gateway off, with a message.
 */
async function openGatewayTunnel(port) {
  const off = (why) =>
    console.error(`gateway tunnel off (${why}): runs work, but segment_sam is not offered\n`);
  try {
    const { Tunnel, install, use } = await import("cloudflared");
    const bin = resolve(homedir(), ".cache/voluma/cloudflared");
    if (!existsSync(bin)) {
      console.log("downloading cloudflared (once) to", bin);
      mkdirSync(resolve(bin, ".."), { recursive: true });
      await install(bin);
    }
    use(bin);
    const tunnel = Tunnel.quick(`http://127.0.0.1:${port}`);
    tunnel.on("url", (url) => {
      env.gatewayUrl = url;
      writeEnv();
      console.log(`gateway ${url} (tunnel to :${port}); start the runner now\n`);
    });
    tunnel.on("error", (error) => off(error.message));
    tunnel.on("exit", () => {
      if (stopping) return;
      if (!env.gatewayUrl) return off("cloudflared exited before it had a URL");
      delete env.gatewayUrl;
      writeEnv();
      console.error("gateway tunnel closed: restart `pnpm dev` for segment_sam\n");
    });
    return tunnel;
  } catch (error) {
    off(error.message);
  }
}
