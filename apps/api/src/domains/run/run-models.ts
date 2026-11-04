/**
 * Which model and thinking level a run uses, decided here when the run is created and recorded on
 * it (`runSchema.model`, `runSchema.thinking`). The list is the same for every caller; what
 * differs is whose key pays. A choice marked `needsVolumaKey` is refused on a run with the
 * starter's own keys: the contributor model lets Meta train on what it is sent, the scan
 * included, so a person's Meta key never may use it. `override` is the debug setting
 * (`RUN_MODEL_OVERRIDE`, read in `index.ts`): every run on Voluma's keys gets it whatever was
 * picked; own-key runs keep their pick, since their Meta key can't call DeepSeek.
 */
import {
  ownKeyMayUse,
  type Run,
  type RunThinking,
  runThinkingSchema,
  usesOwnKey,
} from "@voluma/contracts/run";
import { HTTPException } from "hono/http-exception";

const WONDER = { model: "meta/muse-wonder-1.0", label: "Muse Wonder 1.0" };
const SPARK = { model: "meta/muse-spark-1.3", label: "Muse Spark 1.3" };
const CONTRIBUTOR = {
  model: "meta/muse-spark-1.3-contributor",
  label: "Muse Spark 1.3 Contributor",
  note: "Meta may train on what it is sent, the scan included.",
};
const CHOICES = [WONDER, SPARK, CONTRIBUTOR].map((c) => ({
  ...c,
  needsVolumaKey: !ownKeyMayUse(c.model),
}));
const DEFAULT_MODEL = WONDER.model;

/** The level in the role files (`workflows/core/roles`). Low, medium and high are ones every offered model takes or is mapped to. */
export const DEFAULT_THINKING: RunThinking = "medium";

/** The models `RUN_MODEL_OVERRIDE` may name. */
const OVERRIDES: Record<string, string> = {
  [CONTRIBUTOR.model]: CONTRIBUTOR.label,
  "deepseek/deepseek-flash": "DeepSeek V4.1 Flash",
};

/** Boot-time check of `RUN_MODEL_OVERRIDE`: unset is null, anything not allowed throws. */
export function modelOverride(value: string | undefined): string | null {
  if (!value) return null;
  if (!(value in OVERRIDES))
    throw new Error(`RUN_MODEL_OVERRIDE must be one of ${Object.keys(OVERRIDES).join(", ")}`);
  return value;
}

/** What `GET /models` returns, with the override that forces Voluma-key runs. */
export function modelChoices(override: string | null) {
  return {
    choices: CHOICES,
    default: DEFAULT_MODEL,
    thinking: { choices: runThinkingSchema.options, default: DEFAULT_THINKING },
    ...(override && { forced: { model: override, label: OVERRIDES[override] as string } }),
  };
}

/** The model for a new run: the debug override, else the pick, else the default. 400 for a pick the run's key can't take. */
export function pickModel(
  override: string | null,
  credentials: Run["credentials"],
  requested: string | undefined,
): string {
  if (credentials === "voluma" && override) return override;
  if (requested === undefined) return DEFAULT_MODEL;
  const choice = CHOICES.find((c) => c.model === requested);
  if (!choice)
    throw new HTTPException(400, {
      message: `${requested} is not a model you can pick here. Choose one of: ${CHOICES.map((c) => c.label).join(", ")}.`,
    });
  if (choice.needsVolumaKey && usesOwnKey(credentials))
    throw new HTTPException(400, {
      message: `${choice.label} runs only on Voluma's key, not your own. Choose another model or use Voluma's key.`,
    });
  return requested;
}
