/**
 * The thinking-level check shared by the runner's boot (`RUNNER_THINKING`) and a run's start (a
 * role file's `thinking`). Pi clamps a requested effort a model lacks to a neighbour, so each
 * non-off level is checked against every model it may reach. Unset and `off` both send no
 * requested effort through Pi Agent; they do not require a model that can disable reasoning.
 */
import {
  type Api,
  getSupportedThinkingLevels,
  type Model,
  type ModelThinkingLevel,
} from "@earendil-works/pi-ai";

/** Throws unless every model supports the requested effort; `what` names whose level it is. */
export function assertThinking(
  level: ModelThinkingLevel | undefined,
  models: readonly Model<Api>[],
  what: string,
): void {
  if (level === undefined || level === "off") return;
  for (const m of models) {
    const levels = getSupportedThinkingLevels(m);
    if (!levels.includes(level))
      throw new Error(
        `${what} thinking level "${level}" is not one ${m.provider}/${m.id} supports: ${levels.join(", ")}`,
      );
  }
}
