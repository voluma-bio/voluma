/**
 * What an agent leaves behind when it closes: its NOTES.md (main: plan.md) copied from its `/work`
 * folder to `notesKey`, because `work/` expires 7 days after the run. A folder with no such file
 * leaves nothing. The copy is server-side and safe to repeat, so a close cut off finishes on retry.
 *
 * `restoreMainPlan` is the reverse for a main thread that starts once `work/` has expired: it puts
 * the kept plan back where main's prompts point, before the thread's sandbox is built.
 */
import { notesKey, workPrefix } from "@voluma/contracts/r2";
import { EvidenceNotFound } from "../ports/evidence";
import type { Publish } from "../ports/publish";

export async function keepNotes(
  publish: Publish,
  runId: string,
  agent: { name: string; role: string },
  signal?: AbortSignal,
): Promise<void> {
  const main = agent.role === "main";
  const folder = main ? "main" : agent.name;
  const file = main ? "plan.md" : "NOTES.md";
  try {
    await publish.copy(`${workPrefix(runId)}${folder}/${file}`, notesKey(runId, folder, file), {
      signal,
    });
  } catch (e) {
    if (!(e instanceof EvidenceNotFound)) throw e;
  }
}

export async function restoreMainPlan(
  publish: Publish,
  runId: string,
  signal?: AbortSignal,
): Promise<void> {
  const work = `${workPrefix(runId)}main/plan.md`;
  if ((await publish.read(work, { signal })) !== undefined) return;
  try {
    await publish.copy(notesKey(runId, "main", "plan.md"), work, { signal });
  } catch (e) {
    if (!(e instanceof EvidenceNotFound)) throw e;
  }
}
