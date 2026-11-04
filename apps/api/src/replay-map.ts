/**
 * Throwaway mapping for the hackathon timelapse replay (p1739).
 * Local run ids must not be the staging run id (#564). Review assets and
 * outputs still live under the staging run's R2 prefix; this file remaps
 * reads only. Written by `ops/replay-run.ts`.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export type ReplayMap = {
  localRunId: string;
  localStudyId: string;
  localInputId: string;
  sourceRunId: string;
};

const file = resolve(import.meta.dirname, "../../../.dev/replay.json");

export function loadReplayMap(): ReplayMap | undefined {
  if (!existsSync(file)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as ReplayMap;
    if (
      typeof parsed.localRunId === "string" &&
      typeof parsed.sourceRunId === "string" &&
      parsed.localRunId !== parsed.sourceRunId
    ) {
      return parsed;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/** R2 reads for the local replay run go to the staging run's prefix. Never used for writes. */
export function replaySourceRunId(runId: string): string {
  const map = loadReplayMap();
  return map && runId === map.localRunId ? map.sourceRunId : runId;
}

export function isReplayRun(runId: string): boolean {
  return replaySourceRunId(runId) !== runId;
}
