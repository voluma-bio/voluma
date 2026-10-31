/** Personal preferences keyed by identity, not organization; no local profile copy. */
import { DEFAULT_USER_SETTINGS, type UserSettings } from "@voluma/contracts/settings";
import { pgTable, text } from "drizzle-orm/pg-core";

export const userSettings = pgTable("user_settings", {
  userId: text().primaryKey(),
  theme: text().$type<UserSettings["theme"]>().notNull().default(DEFAULT_USER_SETTINGS.theme),
});
