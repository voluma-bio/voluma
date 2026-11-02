/**
 * Writes `/run/final-outputs.yaml` and `/run/outputs.yaml` (rendered from the events by
 * `output-files.ts`) where `/run` is mounted. One writer per run, coalescing: a refresh asks for a
 * write that starts after the call, and a write renders the latest stored events when it runs, so
 * a slow older write can never land over a newer one. An unchanged file is not written again.
 */
import { renderFinalOutputs, renderOutputsIndex } from "@voluma/contracts/output-files";
import { runFilesPrefix } from "@voluma/contracts/r2";
import type { Files } from "../ports/files";
import type { Recorder } from "../recorder";

export interface RunFiles {
  /** Resolves once the files hold every event stored before the call. */
  refresh(): Promise<void>;
}

export function runFiles(o: {
  runId: string;
  recorder: Recorder;
  files: Files;
  signal: AbortSignal;
}): RunFiles {
  const prefix = runFilesPrefix(o.runId);
  const written = new Map<string, string>();
  let dirty = false;
  let current: Promise<void> | undefined;

  async function writeOnce() {
    const events = o.recorder.events();
    const rendered = {
      "final-outputs.yaml": renderFinalOutputs(events),
      "outputs.yaml": renderOutputsIndex(events),
    };
    for (const [name, text] of Object.entries(rendered)) {
      if (written.get(name) === text) continue;
      await o.files.write(`${prefix}${name}`, Buffer.from(text), o.signal);
      written.set(name, text);
    }
  }

  return {
    refresh() {
      dirty = true;
      current ??= (async () => {
        try {
          while (dirty) {
            dirty = false;
            await writeOnce();
          }
        } finally {
          current = undefined;
        }
      })();
      return current;
    },
  };
}
