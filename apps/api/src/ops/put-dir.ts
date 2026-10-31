/**
 * Operator script: upload a local folder to R2 (objects whose stored ETag equals the file's MD5 are kept; the rest are overwritten)
 * Writes only under `dev/`.
 *   pnpm --filter @voluma/api r2:put --from <dir> --to r2:<prefix>
 * Publishes the dev data other worktrees load: a run dump (`export:run --out r2:…`) and the
 * ce5a0f21 backfill folder (`seed:example --backfill r2:…`).
 */
import { parseArgs } from "node:util";
import { devWritePrefix, r2FromEnv, uploadDir } from "./r2-dir";

const { values } = parseArgs({ options: { from: { type: "string" }, to: { type: "string" } } });
if (!values.from || !values.to) throw new Error("usage: r2:put --from <dir> --to r2:dev/<prefix>");
const prefix = devWritePrefix(values.to);
const { store, bucket } = r2FromEnv();
console.log(`${await uploadDir(store, bucket, values.from, prefix)} files -> r2:${prefix}`);
