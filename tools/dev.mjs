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
 * With `--sam` (`pnpm dev --sam`) and VOLUMA_META_API_KEY set it also starts the provider gateway on a free port (same database,
 * a random GATEWAY_TOKEN_SECRET per launch) and opens a Cloudflare quick tunnel to it: worker
 * sandboxes run on Modal and can reach only an https host, never localhost. The tunnel's URL and
 * the secret join env.json as { gatewayUrl, gatewaySecret }, authoritative for runners using this
 * API. SAM is opt-in because every SAM call costs money and needs Jimmy's yes.
 * Without the tunnel (no `--sam`, no key, or cloudflared can't start) there is no
 * gateway URL: runs work except `segment_sam`, which is not offered. The gateway listens on 127.0.0.1 only. If it or the
 * tunnel dies later, the URL is removed from env.json the same way.
 * `pnpm db:reset` (`node tools/dev.mjs reset`) drops this worktree's database and exits;
 * the next `pnpm dev` recreates and migrates it.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { basename, resolve } from "node:path";
import { parseEnv } from "node:util";
import postgres from "postgres";

// The official release, pinned: every machine runs the same binary. Hashes are the sha256 of each
// asset as published on the release page (GitHub's asset digest); bump the version and all hashes
// together. macOS ships a .tgz, which holds the `cloudflared` binary.
const CLOUDFLARED = {
  version: "2026.10.7",
  assets: {
    "linux-x64": {
      file: "cloudflared-linux-amd64",
      sha256: "1f99fb518b83dec2ba8d870a7cc991d82a77e6196295a3d2754ba17ab9f91872",
    },
    "linux-arm64": {
      file: "cloudflared-linux-arm64",
      sha256: "3df43aedc9ff291d1735b5cb576cb97e0b157488796db2e32b28aecabb445775",
    },
    "darwin-x64": {
      file: "cloudflared-darwin-amd64.tgz",
      sha256: "02f3edfd87684dd5b705607688e4eb4b323f6e777b81e7b3a85af556aa356848",
    },
    "darwin-arm64": {
      file: "cloudflared-darwin-arm64.tgz",
      sha256: "3586ccf397e98e5f437e60e7c307ca6ac463e110580503af8bb8e6f9ebf831bd",
    },
  },
};

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
// SAM is opt-in: each call is paid and needs Jimmy's yes, so a plain `pnpm dev` never offers it.
const samOn = process.argv.includes("--sam");
const metaKey = samOn ? process.env.VOLUMA_META_API_KEY || dotenv.VOLUMA_META_API_KEY : undefined;
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
// Publish whole snapshots: a runner reading a truncated manifest could fall back to inherited
// gateway settings. Recreate the temp file so a crash cannot leave it with an old mode.
const writeEnv = () => {
  const next = `${envPath}.${process.pid}.tmp`;
  rmSync(next, { force: true });
  writeFileSync(next, `${JSON.stringify(env, null, 2)}\n`, { mode: 0o600 });
  renameSync(next, envPath);
};
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
  // tsx ignores node_modules: pnpm's shared hardlinks must not restart other worktrees.
  // Explicit includes also reload source that has not been imported yet, on Linux and macOS.
  spawn(
    "node",
    [
      createRequire(resolve(root, "apps/api/package.json")).resolve("tsx/cli"),
      "watch",
      "--clear-screen=false",
      "--include",
      "src/**",
      "--include",
      "../../packages/*/src/**",
      "--env-file-if-exists",
      envFile,
      "src/index.ts",
    ],
    {
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
    },
  ),
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
let tunnel;
let stopping = false;
let gatewayLost = false;
for (const child of children) {
  child.on("exit", () => stop(1));
}
// Registered before the tunnel's first-run download, which can take a while.
process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));
if (gatewayPort) {
  // Not in `children`: a gateway that dies only turns segment_sam off, like the tunnel.
  const gateway = spawn("node", ["--import", "tsx", "src/main.ts"], {
    cwd: resolve(root, "apps/gateway"),
    stdio: "inherit",
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl.href,
      GATEWAY_TOKEN_SECRET: env.gatewaySecret,
      GATEWAY_META_API_KEY: metaKey,
      PORT: String(gatewayPort),
      HOST: "127.0.0.1",
    },
  });
  children.push(gateway);
  gateway.on("exit", (code) => gatewayOff(`the gateway exited with ${code}`));
  tunnel = await openGatewayTunnel(gatewayPort);
} else {
  console.log(
    samOn
      ? "gateway off: set VOLUMA_META_API_KEY in .env for segment_sam in local runs\n"
      : "gateway off: segment_sam is off (each SAM call is paid; with Jimmy's yes, run `pnpm dev --sam`)\n",
  );
}
/** The gateway or its tunnel is gone: no gateway URL, so no new run gets segment_sam. */
function gatewayOff(why) {
  if (stopping || gatewayLost) return;
  gatewayLost = true;
  delete env.gatewayUrl;
  writeEnv();
  tunnel?.stop();
  console.error(
    `gateway off (${why}): runs work, but segment_sam is not offered. Fix it, then restart \`pnpm dev\` and the runner (it reads the gateway once, at start)\n`,
  );
}
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
 * Downloads the pinned cloudflared to `bin`, checking its sha256. The file at `bin` is only ever
 * a verified, executable binary: it is built in a private temp dir and renamed into place, so an
 * interrupted download, or two worktrees downloading at once, leaves nothing half-written there.
 */
async function downloadCloudflared(bin) {
  const asset = CLOUDFLARED.assets[`${process.platform}-${process.arch}`];
  if (!asset) throw new Error(`no pinned cloudflared for ${process.platform}-${process.arch}`);
  const url = `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED.version}/${asset.file}`;
  console.log(`downloading cloudflared ${CLOUDFLARED.version} (once) to ${bin}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`downloading cloudflared: HTTP ${res.status}`);
  const body = Buffer.from(await res.arrayBuffer());
  const sha256 = createHash("sha256").update(body).digest("hex");
  if (sha256 !== asset.sha256)
    throw new Error(`cloudflared download refused: sha256 ${sha256}, expected ${asset.sha256}`);
  const dir = mkdtempSync(resolve(bin, "..", ".download-"));
  try {
    if (asset.file.endsWith(".tgz")) {
      writeFileSync(resolve(dir, asset.file), body);
      const tar = spawnSync("tar", ["-xzf", asset.file], { cwd: dir });
      if (tar.status !== 0) throw new Error(`extracting cloudflared: ${tar.stderr}`);
    } else {
      writeFileSync(resolve(dir, "cloudflared"), body);
    }
    chmodSync(resolve(dir, "cloudflared"), 0o755);
    renameSync(resolve(dir, "cloudflared"), bin);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * A Cloudflare quick tunnel (no account) to the local gateway, so a Modal sandbox can reach it.
 * The binary is downloaded once into ~/.cache/voluma, shared by all worktrees. Gateway token
 * auth stays on: the URL is public. Any failure only turns the gateway off, with a message.
 */
async function openGatewayTunnel(port) {
  try {
    const { Tunnel, use } = await import("cloudflared");
    if (stopping || gatewayLost) return;
    const bin = resolve(homedir(), ".cache/voluma", `cloudflared-${CLOUDFLARED.version}`);
    if (!existsSync(bin)) {
      mkdirSync(resolve(bin, ".."), { recursive: true });
      await downloadCloudflared(bin);
    }
    if (stopping || gatewayLost) return;
    use(bin);
    const tunnel = Tunnel.quick(`http://127.0.0.1:${port}`);
    tunnel.on("url", (url) => {
      if (stopping || gatewayLost) return tunnel.stop();
      env.gatewayUrl = url;
      writeEnv();
      console.log(`gateway ${url} (tunnel to :${port}); start the runner now\n`);
    });
    tunnel.on("error", (error) => gatewayOff(`tunnel: ${error.message}`));
    tunnel.on("exit", () => gatewayOff("the tunnel closed"));
    return tunnel;
  } catch (error) {
    gatewayOff(error.message);
  }
}
