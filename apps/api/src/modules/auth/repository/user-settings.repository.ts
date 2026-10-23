import { and, eq } from "drizzle-orm";
import { userSettings, type Db } from "@navet/db";
import { lockThemeForSetting } from "../../system/repository/themes.repository.js";
import { USER_THEME_SETTING_KEY } from "../../system/service/theme-settings.js";

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

    // Egna teman: the user's theme, stored only while the theme exists (the
    // theme row is locked against a concurrent delete — see
    // lockThemeForSetting); null removes the choice (= the company default).
    // False = unknown theme, nothing written.
    async setTheme(userId: string, theme: string | null): Promise<boolean> {
      if (theme === null) {
        await db
          .delete(userSettings)
          .where(and(eq(userSettings.userId, userId), eq(userSettings.key, USER_THEME_SETTING_KEY)));
        return true;
      }
      return db.transaction(async (tx) => {
        if (!(await lockThemeForSetting(tx, theme))) return false;
        await tx
          .insert(userSettings)
          .values({ userId, key: USER_THEME_SETTING_KEY, value: theme })
          .onConflictDoUpdate({ target: [userSettings.userId, userSettings.key], set: { value: theme } });
        return true;
      });
    },
  };
}

export type UserSettingsRepository = ReturnType<typeof createUserSettingsRepository>;
