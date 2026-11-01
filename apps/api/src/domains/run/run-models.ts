/**
 * Which model a run uses, decided here when the run is created and recorded on it
 * (`runSchema.model`). The choices depend on who pays: Voluma's keys may pick the
 * contributor model (Meta may train on what it is sent, the scan included); a visitor's own
 * Meta key never may. `override` is the debug setting (`RUN_MODEL_OVERRIDE`, read in
 * `index.ts`): every run on Voluma's keys gets it whatever was picked. Visitor runs keep
 * their pick: their Meta key cannot call DeepSeek, and contributor is never allowed on it.
 */
import type { RunModelsResponse } from "@voluma/contracts/run";
import { HTTPException } from "hono/http-exception";

const WONDER = { model: "meta/muse-wonder-1.0", label: "Muse Wonder 1.0" };
const SPARK = { model: "meta/muse-spark-1.3", label: "Muse Spark 1.3" };
const CONTRIBUTOR = {
  model: "meta/muse-spark-1.3-contributor",
  label: "Muse Spark 1.3 Contributor",
  note: "Meta may train on what it is sent, the scan included.",
};

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

const CHOICES = {
  voluma: { choices: [WONDER, SPARK, CONTRIBUTOR], default: WONDER.model },
  visitor: { choices: [WONDER, SPARK], default: WONDER.model },
};

/** The choices for both kinds of caller, with the override that forces Voluma-key runs (`GET /models` trims them per caller). */
export function modelChoices(override: string | null) {
  return {
    ...CHOICES,
    ...(override && { forced: { model: override, label: OVERRIDES[override] as string } }),
  };
}

/** The model for a new run: the debug override, else the pick, else the default. 400 for a pick the caller may not make. */
export function pickModel(
  override: string | null,
  credentials: "voluma" | "visitor",
  requested: string | undefined,
): string {
  if (credentials === "voluma" && override) return override;
  const { choices, default: fallback } = CHOICES[credentials];
  if (requested === undefined) return fallback;
  if (!choices.some((c) => c.model === requested))
    throw new HTTPException(400, {
      message: `${requested} is not a model you can pick here. Choose one of: ${choices.map((c) => c.label).join(", ")}.`,
    });
  return requested;
}
