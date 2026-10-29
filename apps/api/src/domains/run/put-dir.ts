/**
 * Operator script: upload a local folder to R2 (objects already stored with the same size are kept).
 *   pnpm --filter @voluma/api r2:put --from <dir> --to r2:<prefix>
 * Publishes the dev data other worktrees load: a run dump (`export:run --out r2:…`) and the
 * ce5a0f21 backfill folder (`seed:example --backfill r2:…`).
 */
import { parseArgs } from "node:util";
import { r2FromEnv, r2Prefix, uploadDir } from "./r2-dir";

const { values } = parseArgs({ options: { from: { type: "string" }, to: { type: "string" } } });
const prefix = values.to ? r2Prefix(values.to) : null;
if (!values.from || !prefix) throw new Error("usage: r2:put --from <dir> --to r2:<prefix>");
const { r2, bucket } = r2FromEnv();
console.log(`${await uploadDir(r2, bucket, values.from, prefix)} files -> r2:${prefix}`);
