import {
  ALERT_KINDS,
  DEFAULT_LIST_PAGE_SIZE,
  favoriteSchema,
  LIST_PAGE_SIZE_OPTIONS,
  MAX_FAVORITES,
  type AlertKind,
  type Favorite,
  type UpdateUserSettingsInput,
  type UserSettings,
} from "@navet/shared";
import type { UserSettingsRepository } from "../repository/user-settings.repository.js";
import { decodeUserTheme, USER_THEME_SETTING_KEY } from "../../system/service/theme-settings.js";
import { UnknownThemeError } from "../../system/service/themes.errors.js";

const LIST_PAGE_SIZE_KEY = "list_page_size";
const HIDE_ONBOARDING_KEY = "hide_onboarding";
// Aviseringar: the daily digest opt-in and its kind filter (a JSON array of
// kind keys; absent or "null" = every kind the user may see).
const ALERT_DIGEST_KEY = "alert_digest";
const ALERT_DIGEST_KINDS_KEY = "alert_digest_kinds";
// Favoriter: a JSON array of { href, title }, in the order shown.
const FAVORITES_KEY = "favorites";

const LIST_PAGE_SIZE_VALUES: readonly number[] = LIST_PAGE_SIZE_OPTIONS;
const KNOWN_ALERT_KINDS: ReadonlySet<string> = new Set(ALERT_KINDS);

function isValidListPageSize(value: number): value is UserSettings["listPageSize"] {
  return LIST_PAGE_SIZE_VALUES.includes(value);
}

// A stored list is kept to the kinds that still exist (a kind removed from
// the catalog is dropped, like a removed permission in a group); anything
// unparseable falls back to null = all. Exported for the digest job, which
// reads the stored value straight from its recipient query.
export function decodeAlertDigestKinds(raw: string | undefined): AlertKind[] | null {
  if (raw === undefined || raw === "null") return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const kinds = parsed.filter((k): k is AlertKind => typeof k === "string" && KNOWN_ALERT_KINDS.has(k));
    return [...new Set(kinds)];
  } catch {
    return null;
  }
}

// A stored list is read entry by entry: anything that no longer passes the
// schema is dropped (and a repeated href kept once) rather than failing the
// whole settings read; unparseable = none.
export function decodeFavorites(raw: string | undefined): Favorite[] {
  if (raw === undefined) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    const favorites: Favorite[] = [];
    for (const entry of parsed) {
      const result = favoriteSchema.safeParse(entry);
      if (!result.success || seen.has(result.data.href)) continue;
      seen.add(result.data.href);
      favorites.push(result.data);
    }
    return favorites.slice(0, MAX_FAVORITES);
  } catch {
    return [];
  }
}

export function createUserSettingsService(repo: UserSettingsRepository) {
  // Typed view over the user_settings KV rows for one user — mirrors
  // system.service.ts's getSettings() pattern, just per-user instead of
  // global. A row with a stale/unrecognized value (e.g. a since-removed
  // option) falls back to the default rather than surfacing garbage.
  async function getSettings(userId: string): Promise<UserSettings> {
    const rows = await repo.getAll(userId);
    const byKey = new Map(rows.map((row) => [row.key, row.value] as const));
    const raw = byKey.get(LIST_PAGE_SIZE_KEY);
    const parsed = raw === undefined ? NaN : Number(raw);
    const listPageSize = isValidListPageSize(parsed) ? parsed : DEFAULT_LIST_PAGE_SIZE;
    return {
      listPageSize,
      hideOnboarding: byKey.get(HIDE_ONBOARDING_KEY) === "true",
      alertDigest: byKey.get(ALERT_DIGEST_KEY) === "true",
      alertDigestKinds: decodeAlertDigestKinds(byKey.get(ALERT_DIGEST_KINDS_KEY)),
      theme: decodeUserTheme(byKey.get(USER_THEME_SETTING_KEY)),
      favorites: decodeFavorites(byKey.get(FAVORITES_KEY)),
    };
  }

  return {
    getSettings,

    async updateSettings(userId: string, input: UpdateUserSettingsInput): Promise<UserSettings> {
      // First, so an unknown theme refuses the request before anything else
      // is written.
      if (input.theme !== undefined && !(await repo.setTheme(userId, input.theme))) {
        throw new UnknownThemeError(input.theme!);
      }
      if (input.listPageSize !== undefined) {
        await repo.upsert(userId, LIST_PAGE_SIZE_KEY, String(input.listPageSize));
      }
      if (input.hideOnboarding !== undefined) {
        await repo.upsert(userId, HIDE_ONBOARDING_KEY, String(input.hideOnboarding));
      }
      if (input.alertDigest !== undefined) {
        await repo.upsert(userId, ALERT_DIGEST_KEY, String(input.alertDigest));
      }
      if (input.alertDigestKinds !== undefined) {
        await repo.upsert(
          userId,
          ALERT_DIGEST_KINDS_KEY,
          input.alertDigestKinds === null ? "null" : JSON.stringify([...new Set(input.alertDigestKinds)])
        );
      }
      if (input.favorites !== undefined) {
        await repo.upsert(userId, FAVORITES_KEY, JSON.stringify(input.favorites));
      }
      return getSettings(userId);
    },
  };
}

export type UserSettingsService = ReturnType<typeof createUserSettingsService>;
