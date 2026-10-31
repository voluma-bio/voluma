/**
 * Applies the committed Drizzle migrations to DATABASE_URL. The one migration path:
 * `pnpm db:migrate` locally, the Render pre-deploy command in production.
 * Not drizzle-kit, which is a devDependency and exits 1 without the error text.
 */
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");
// A DDL statement waiting for a lock queues every later query on that table behind it, and the
// old code is still serving. So give up on a lock after LOCK_TIMEOUT_MS (the wait for one lock,
// not the statement's run time) and retry: the migrations are one transaction, so a timeout
// leaves nothing applied.
const LOCK_TIMEOUT_MS = 5000;
const ATTEMPTS = 6;
const LOCK_NOT_AVAILABLE = "55P03";
const client = postgres(url, {
  max: 1,
  onnotice: () => {},
  connection: { lock_timeout: LOCK_TIMEOUT_MS },
});
try {
  for (let attempt = 1; ; attempt++) {
    try {
      await migrate(drizzle(client), {
        migrationsFolder: resolve(import.meta.dirname, "../drizzle"),
      });
      break;
    } catch (error) {
      // Drizzle wraps the driver error: the code is on its cause.
      const code = (error as { cause?: { code?: string } }).cause?.code;
      if (code !== LOCK_NOT_AVAILABLE || attempt === ATTEMPTS) throw error;
      console.error(`migration waited too long for a lock (attempt ${attempt}); retrying`);
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
  console.log("migrations applied");
} catch (error) {
  console.error("migration failed:", error);
  process.exitCode = 1;
} finally {
  await client.end();
}
