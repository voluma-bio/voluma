/**
 * Applies the committed Drizzle migrations to DATABASE_URL. The one migration path:
 * `pnpm db:migrate` locally, the Railway pre-deploy step in production (railway.json).
 * Not drizzle-kit, which is a devDependency and exits 1 without the error text.
 */
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");
const client = postgres(url, { max: 1 });
try {
  await migrate(drizzle(client), { migrationsFolder: resolve(import.meta.dirname, "../drizzle") });
  console.log("migrations applied");
} catch (error) {
  console.error("migration failed:", error);
  process.exitCode = 1;
} finally {
  await client.end();
}
