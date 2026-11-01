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
import { THINKING_LEVELS } from "@voluma/workflow/definition";

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

/**
 * The level to send a model for a wanted one: the wanted level if it supports it, else the
 * nearest it supports above, else below. Unset and `off` stay as they are.
 */
export function nearestThinking(
  wanted: ModelThinkingLevel | undefined,
  model: Model<Api>,
): ModelThinkingLevel | undefined {
  if (wanted === undefined || wanted === "off") return wanted;
  const supported = getSupportedThinkingLevels(model);
  const order = THINKING_LEVELS.filter((l) => supported.includes(l) && l !== "off");
  const at = THINKING_LEVELS.indexOf(wanted);
  return (
    order.find((l) => THINKING_LEVELS.indexOf(l) >= at) ??
    order.findLast((l) => THINKING_LEVELS.indexOf(l) < at) ??
    wanted
  );
}
