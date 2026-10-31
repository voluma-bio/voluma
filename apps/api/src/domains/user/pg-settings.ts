/** Postgres settings: reads do not create rows; saves atomically upsert only changed fields. */
import {
  DEFAULT_USER_SETTINGS,
  type UpdateUserSettingsRequest,
  type UserSettings,
  userSettingsSchema,
} from "@voluma/contracts/settings";
import { eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { userSettings } from "./schema";

export function pgUserSettings(db: PostgresJsDatabase) {
  return {
    async get(userId: string): Promise<UserSettings> {
      const [settings] = await db
        .select({ theme: userSettings.theme })
        .from(userSettings)
        .where(eq(userSettings.userId, userId));
      return settings ?? { ...DEFAULT_USER_SETTINGS };
    },
    async update(userId: string, patch: UpdateUserSettingsRequest): Promise<UserSettings> {
      const [settings] = await db
        .insert(userSettings)
        .values({ userId, ...patch })
        .onConflictDoUpdate({ target: userSettings.userId, set: patch })
        .returning({ theme: userSettings.theme });
      return userSettingsSchema.parse(settings);
    },
  };
}

export type UserSettingsStore = ReturnType<typeof pgUserSettings>;
