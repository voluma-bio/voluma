/**
 * The gateway service (`pnpm --filter @voluma/gateway start`). Settings come from the
 * environment, the only place keys live:
 *   DATABASE_URL            the API's Postgres; the gateway refuses to start until its migration ran
 *   GATEWAY_TOKEN_SECRET    `<kid>:<base64 of 32 bytes>[,…]`, the same value the runner mints with
 *   GATEWAY_META_API_KEY, GATEWAY_ANTHROPIC_API_KEY, GATEWAY_OPENAI_API_KEY   our keys (each optional)
 *   GATEWAY_<PROVIDER>_BASE_URL   optional: another upstream (tests use local stubs)
 *   GATEWAY_DRAIN_SECONDS   how long SIGTERM waits for calls in flight (default 60)
 *   PORT                    default 8080
 * Every 5 minutes, and at boot, open rows older than the longest call are marked `cut`.
 * On SIGTERM: stop taking calls, drain, mark this instance's still-open rows `cut`, exit.
 */
import { randomUUID } from "node:crypto";
import {
  cutOwnCalls,
  cutStaleCalls,
  PROVIDER_NAMES,
  PROVIDERS,
  type Provider,
  parseTokenSecrets,
} from "@voluma/provider-calls";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { createGateway } from "./gateway.ts";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`);
const instance = `${process.env.RAILWAY_DEPLOYMENT_ID ?? "local"}-${randomUUID().slice(0, 8)}`;
const SWEEP_MS = 5 * 60_000;
const drainMs = Number(process.env.GATEWAY_DRAIN_SECONDS ?? 60) * 1000;

const client = postgres(required("DATABASE_URL"), { max: 10, onnotice: () => {} });
const db = drizzle(client, { casing: "snake_case" });

// The migration lives in apps/api; a gateway that starts before it would fail every call.
const [migrated] = await db.execute<{ ok: boolean }>(
  `SELECT to_regclass('provider_calls') IS NOT NULL AND EXISTS (
     SELECT 1 FROM information_schema.columns
     WHERE table_name = 'runs' AND column_name = 'cost_cap_usd')
   AND EXISTS (
     SELECT 1 FROM information_schema.columns
     WHERE table_name = 'provider_calls' AND column_name = 'reserved_usd'
       AND is_nullable = 'YES') AS ok`,
);
if (!migrated?.ok)
  throw new Error(
    "the database is not migrated (provider_calls, runs.cost_cap_usd, nullable provider_calls.reserved_usd)",
  );

const keys: Partial<Record<Provider, string>> = {};
const baseUrls = {} as Record<Provider, string>;
for (const name of PROVIDER_NAMES) {
  const upper = name.toUpperCase();
  const key = process.env[`GATEWAY_${upper}_API_KEY`];
  if (key) keys[name] = key;
  baseUrls[name] = (process.env[`GATEWAY_${upper}_BASE_URL`] ?? PROVIDERS[name].baseUrl).replace(
    /\/$/,
    "",
  );
}

/** Closes rows no live call owns (a crashed instance's, or a settle that kept failing). */
const sweep = async () => {
  try {
    const cut = await cutStaleCalls(db);
    if (cut > 0) log(`${cut} stale open row(s) cut`);
    return cut;
  } catch (error) {
    log(`stale sweep failed: ${error instanceof Error ? error.message : error}`);
    return 0;
  }
};
const staleCut = await sweep();
setInterval(sweep, SWEEP_MS).unref();
const gateway = createGateway({
  db,
  secrets: parseTokenSecrets(required("GATEWAY_TOKEN_SECRET")),
  keys,
  baseUrls,
  instance,
  log,
});
const port = Number(process.env.PORT ?? 8080);
gateway.server.listen(port, () => {
  log(
    `${instance} up on :${port}; keys for ${Object.keys(keys).join(", ") || "none"}; ${staleCut} stale open row(s) cut`,
  );
});

let signals = 0;
for (const name of ["SIGINT", "SIGTERM"] as const) {
  process.on(name, async () => {
    if (++signals > 1) process.exit(130);
    log(`${name}: draining for up to ${drainMs / 1000}s`);
    await gateway.drain(drainMs);
    const cut = await cutOwnCalls(db, instance);
    log(`drained; ${cut} open row(s) cut`);
    await client.end({ timeout: 5 });
    process.exit(0);
  });
}
