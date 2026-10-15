import { eq } from "drizzle-orm";
import { userSettings, type Db } from "@navet/db";

export function createUserSettingsRepository(db: Db) {
  return {
    async getAll(userId: string) {
      return db
        .select({ key: userSettings.key, value: userSettings.value })
        .from(userSettings)
        .where(eq(userSettings.userId, userId));
    },

    async upsert(userId: string, key: string, value: string) {
      await db
        .insert(userSettings)
        .values({ userId, key, value })
        .onConflictDoUpdate({ target: [userSettings.userId, userSettings.key], set: { value } });
    },
  };
}

export type UserSettingsRepository = ReturnType<typeof createUserSettingsRepository>;
