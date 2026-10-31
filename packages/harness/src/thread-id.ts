/**
 * Thread ids. A new thread's id is a UUIDv5 of its run and name, minted once when the thread
 * first starts; every later reader takes the id from the thread's `thread.started` record and
 * never rebuilds or parses it. Runs recorded before this keep their stored ids
 * (`<runId>.<name>`).
 */
import { createHash } from "node:crypto";

/** Fixed namespace for thread ids; changing it changes every id minted afterwards. */
const THREAD_NAMESPACE = "6f1c6d0e-7a53-4e0b-9c52-3b0a2f4d8e17";

/** `uuid5(THREAD_NAMESPACE, "<runId>.<name>")`: opaque, and unique per run because names are. */
export function threadIdOf(runId: string, name: string): string {
  const hash = createHash("sha1")
    .update(Buffer.from(THREAD_NAMESPACE.replaceAll("-", ""), "hex"))
    .update(`${runId}.${name}`)
    .digest();
  hash[6] = ((hash[6] as number) & 0x0f) | 0x50;
  hash[8] = ((hash[8] as number) & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
