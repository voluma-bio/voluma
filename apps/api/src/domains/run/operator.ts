/**
 * Shared by the operator scripts (`export:run`, `import:run`, `seed:example`): which database
 * they write to, and the guard that keeps a local run from touching a shared one.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * DATABASE_URL, else the one `pnpm dev` wrote to `.dev/env.json` for this worktree. Prints the
 * host and database name. With `writes`, a host that isn't this machine is refused without `--remote`.
 */
export function databaseUrl({ writes, remote }: { writes: boolean; remote?: boolean }): string {
  const file = resolve(import.meta.dirname, "../../../../../.dev/env.json");
  const url =
    process.env.DATABASE_URL ||
    (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")).databaseUrl : undefined);
  if (!url) throw new Error("set DATABASE_URL, or run `pnpm dev` in this worktree first");
  const { hostname, host, pathname } = new URL(url);
  console.log(`database ${host}${pathname}`);
  if (writes && !remote && !LOCAL_HOSTS.has(hostname)) {
    throw new Error(`${host} is not a local database; pass --remote to write to it`);
  }
  return url;
}
