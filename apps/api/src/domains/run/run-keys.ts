/**
 * An own-key run's keys (`@voluma/contracts/run`, "Starting work"), sealed with AES-256-GCM
 * under `RUN_KEY_SECRET` into `runs.sealed_keys` for the run's life, so a claim after any deploy
 * or runner restart finds them. Only the queue (pg-queue.ts) touches the column: it seals at
 * start and reopen, a claim opens them, and a run that ends nulls them. The run id is
 * the authenticated data, so a sealed value moved to another run does not open. Never log or
 * return a sealed or opened value except in the claim.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { type OwnKeys, ownKeysSchema } from "@voluma/contracts/run";

const IV_BYTES = 12;
const TAG_BYTES = 16;

export type KeySealer = {
  seal(runId: string, keys: OwnKeys): string;
  /** The keys, or undefined when the value is missing, was sealed under another secret, or was altered. */
  open(runId: string, sealed: string | null): OwnKeys | undefined;
};

export function keySealer(secret: string): KeySealer {
  const key = createHash("sha256").update(secret).digest();
  return {
    seal(runId, keys) {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv("aes-256-gcm", key, iv).setAAD(Buffer.from(runId));
      const body = Buffer.concat([cipher.update(JSON.stringify(keys), "utf8"), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
    },
    open(runId, sealed) {
      if (!sealed) return undefined;
      try {
        const raw = Buffer.from(sealed, "base64");
        const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, IV_BYTES))
          .setAAD(Buffer.from(runId))
          .setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
        const text = Buffer.concat([
          decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)),
          decipher.final(),
        ]).toString("utf8");
        return ownKeysSchema.parse(JSON.parse(text));
      } catch {
        // A rotated secret or a damaged value: the run asks for its keys again.
        return undefined;
      }
    },
  };
}
