/**
 * What an agent leaves behind when it closes: its NOTES.md (main: plan.md) copied from its `/work`
 * folder to `notesKey`, because `work/` expires 7 days after the run. A folder with no such file
 * leaves nothing. The copy is server-side and safe to repeat, so a close cut off finishes on retry.
 *
 * `restoreMainPlan` is the reverse for a main thread that starts once `work/` has expired: it puts
 * the kept plan back where main's prompts point, before the thread's sandbox is built.
 */
import { notesKey, workPrefix } from "@voluma/contracts/r2";
import { FileNotFound, FileRefused, type RunBucket } from "./ports/bucket";

export async function keepNotes(
  bucket: RunBucket,
  runId: string,
  agent: { name: string; role: string },
  signal?: AbortSignal,
): Promise<void> {
  const main = agent.role === "main";
  const folder = main ? "main" : agent.name;
  const file = main ? "plan.md" : "NOTES.md";
  try {
    await bucket.copy(`${workPrefix(runId)}${folder}/${file}`, notesKey(runId, folder, file), {
      signal,
    });
  } catch (e) {
    if (!(e instanceof FileNotFound)) throw e;
  }
}

export async function restoreMainPlan(
  bucket: RunBucket,
  runId: string,
  signal?: AbortSignal,
): Promise<void> {
  const work = `${workPrefix(runId)}main/plan.md`;
  try {
    if ((await bucket.readText(work, { signal })) !== undefined) return;
  } catch (e) {
    // A plan over `read`'s 1 MiB is there: nothing to restore.
    if (e instanceof FileRefused) return;
    throw e;
  }
  try {
    await bucket.copy(notesKey(runId, "main", "plan.md"), work, { signal });
  } catch (e) {
    if (!(e instanceof FileNotFound)) throw e;
  }
}
