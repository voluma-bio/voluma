/**
 * The thinking-level check shared by the runner's boot (`RUNNER_THINKING`) and a run's start (a
 * role file's `thinking`). Pi clamps a level a model lacks to a neighbour, so a level someone set
 * is checked against every model it may reach; one nobody set sends none and checks nothing
 * (Meta's Muse models take no `off`).
 */
import {
  type Api,
  getSupportedThinkingLevels,
  type Model,
  type ModelThinkingLevel,
} from "@earendil-works/pi-ai";

/** Throws unless every model supports `level`; `what` names whose level it is. */
export function assertThinking(
  level: ModelThinkingLevel | undefined,
  models: readonly Model<Api>[],
  what: string,
): void {
  if (!level) return;
  for (const m of models) {
    const levels = getSupportedThinkingLevels(m);
    if (!levels.includes(level))
      throw new Error(
        `${what} thinking level "${level}" is not one ${m.provider}/${m.id} supports: ${levels.join(", ")}`,
      );
  }
}
