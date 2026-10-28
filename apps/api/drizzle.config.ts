/** drizzle-kit, for `pnpm --filter @voluma/api db:generate` only. Migrations run from src/migrate.ts; never `push`. */
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/domains/*/schema.ts",
  out: "./drizzle",
  casing: "snake_case",
  dbCredentials: { url: process.env.DATABASE_URL ?? "" },
});
