import { and, asc, count, eq, isNull, sql } from "drizzle-orm";
import { systemSettings, themes, userSettings, users, type Db, type Tx } from "@navet/db";
import { isBuiltinThemeId, type ThemeScheme, type ThemeSource } from "@navet/shared";
import { DEFAULT_THEME_KEY, USER_THEME_SETTING_KEY } from "../service/theme-settings.js";

export type ThemeRow = typeof themes.$inferSelect;

// Whether a theme id may be stored in a setting, inside the setting's own
// transaction: a built-in id always, a custom key only while its row exists
// — taken FOR SHARE, so a concurrent delete (which takes the row FOR UPDATE
// first) waits for the setting to commit, then sees it and refuses or resets
// it. Shared by PATCH /settings (defaultTheme) and PATCH /me/settings (theme).
export async function lockThemeForSetting(tx: Tx, id: string): Promise<boolean> {
  if (isBuiltinThemeId(id)) return true;
  const rows = await tx.select({ id: themes.id }).from(themes).where(eq(themes.key, id)).for("share");
  return rows.length > 0;
}

export function createThemesRepository(db: Db) {
  return {
    async list(): Promise<ThemeRow[]> {
      return db.select().from(themes).orderBy(asc(themes.name));
    },

    async get(id: string): Promise<ThemeRow | null> {
      const [row] = await db.select().from(themes).where(eq(themes.id, id));
      return row ?? null;
    },

    // Användas av: active and inactive accounts, never soft-deleted ones.
    async usage(): Promise<Map<string, number>> {
      const rows = await db
        .select({ theme: userSettings.value, n: count() })
        .from(userSettings)
        .innerJoin(users, eq(users.id, userSettings.userId))
        .where(and(eq(userSettings.key, USER_THEME_SETTING_KEY), isNull(users.deletedAt)))
        .groupBy(userSettings.value);
      return new Map(rows.map((r) => [r.theme, Number(r.n)]));
    },

    // The cap is checked under an advisory lock so two uploads can't both
    // squeeze in as number 50. "limit" = refused, nothing written.
    async create(
      values: { key: string; name: string; scheme: ThemeScheme; tokens: Record<string, string>; source: ThemeSource | null; userId: string | null },
      max: number
    ): Promise<ThemeRow | "limit"> {
      return db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('themes'))`);
        const [{ n }] = (await tx.select({ n: count() }).from(themes)) as [{ n: number }];
        if (Number(n) >= max) return "limit";
        const [row] = await tx
          .insert(themes)
          .values({
            key: values.key,
            name: values.name,
            scheme: values.scheme,
            tokens: values.tokens,
            source: values.source,
            createdBy: values.userId,
            updatedBy: values.userId,
          })
          .returning();
        return row!;
      });
    },

    async update(
      id: string,
      values: { name: string; scheme: ThemeScheme; tokens: Record<string, string>; source: ThemeSource | null; userId: string | null }
    ): Promise<ThemeRow | null> {
      const [row] = await db
        .update(themes)
        .set({
          name: values.name,
          scheme: values.scheme,
          tokens: values.tokens,
          source: values.source,
          updatedBy: values.userId,
          updatedAt: new Date(),
        })
        .where(eq(themes.id, id))
        .returning();
      return row ?? null;
    },

    // One transaction: the theme row FOR UPDATE first (the settings writers
    // take it FOR SHARE), then the default — refused while the theme is the
    // company default — then every user's choice of it is reset to the
    // default (their row removed) and the theme deleted.
    async delete(
      id: string
    ): Promise<{ status: "not_found" } | { status: "default"; row: ThemeRow } | { status: "deleted"; row: ThemeRow; usersReset: number }> {
      return db.transaction(async (tx) => {
        const [row] = await tx.select().from(themes).where(eq(themes.id, id)).for("update");
        if (!row) return { status: "not_found" as const };
        const [current] = await tx
          .select({ value: systemSettings.value })
          .from(systemSettings)
          .where(eq(systemSettings.key, DEFAULT_THEME_KEY))
          .for("update");
        if (current?.value === row.key) return { status: "default" as const, row };
        const reset = await tx
          .delete(userSettings)
          .where(and(eq(userSettings.key, USER_THEME_SETTING_KEY), eq(userSettings.value, row.key)))
          .returning({ userId: userSettings.userId });
        await tx.delete(themes).where(eq(themes.id, id));
        return { status: "deleted" as const, row, usersReset: reset.length };
      });
    },
  };
}

export type ThemesRepository = ReturnType<typeof createThemesRepository>;
