/**
 * Personal settings, independent of lab membership. GET /api/user/settings returns
 * the caller's settings (defaults before the first save); POST updates only the
 * supplied fields and returns the saved settings. Both require a user session,
 * including guests. Identity comes from the session, never the request body.
 * The web shell applies the saved theme across all pages.
 */
import { z } from "zod";

export const userSettingsSchema = z.object({
  theme: z.enum(["light", "dark"]),
});
export type UserSettings = z.infer<typeof userSettingsSchema>;

export const DEFAULT_USER_SETTINGS: Readonly<UserSettings> = { theme: "light" };

/** Unknown fields and empty updates are errors, not silently ignored saves. */
export const updateUserSettingsRequestSchema = userSettingsSchema
  .partial()
  .strict()
  .refine((settings) => Object.keys(settings).length > 0, "Provide a setting to update");
export type UpdateUserSettingsRequest = z.infer<typeof updateUserSettingsRequestSchema>;
