import {
  ALERT_KINDS,
  DEFAULT_LIST_PAGE_SIZE,
  favoriteSchema,
  LIST_PAGE_SIZE_OPTIONS,
  listColumnsEntrySchema,
  listColumnsKeySchema,
  MAX_FAVORITES,
  MAX_LIST_COLUMN_LISTS,
  TABLE_DENSITIES,
  type ListColumnsEntry,
  type TableDensity,
  OVERVIEW_CARDS,
  type OverviewCard,
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
// Favoriter i sidomenyn — absent = true (the menu shows them, as before).
const FAVORITES_IN_SIDEBAR_KEY = "favorites_in_sidebar";
// Aviseringar: the daily digest opt-in and its kind filter (a JSON array of
// kind keys; absent or "null" = every kind the user may see).
const ALERT_DIGEST_KEY = "alert_digest";
const ALERT_DIGEST_KINDS_KEY = "alert_digest_kinds";
// Favoriter: a JSON array of { href, title }, in the order shown.
const FAVORITES_KEY = "favorites";

// Översikten: a JSON array of card keys in display order; absent or "null" =
// the standard.
const OVERVIEW_CARDS_KEY = "overview_cards";

// Täthet and Kolumner (Nav som program, punkt 6). list_columns is a JSON
// object { "<list path>": { hidden, widths } }, merged per list on PATCH.
const DENSITY_KEY = "table_density";
const LIST_COLUMNS_KEY = "list_columns";

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

// Unknown keys (a card removed in a later version) are dropped and repeats
// kept once; unparseable or absent = null = standard. Never fails the read.
export function decodeOverviewCards(raw: string | undefined): OverviewCard[] | null {
  if (raw === undefined || raw === "null") return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const known: ReadonlySet<string> = new Set(OVERVIEW_CARDS);
    const cards = parsed.filter((k): k is OverviewCard => typeof k === "string" && known.has(k));
    return [...new Set(cards)];
  } catch {
    return null;
  }
}

// Entry by entry, like the favourites: a list or a width that no longer
// passes the schema is dropped, repeats in `hidden` kept once, and an empty
// entry is the same as none. Unparseable = {}.
export function decodeListColumns(raw: string | undefined): Record<string, ListColumnsEntry> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const lists: Record<string, ListColumnsEntry> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (!listColumnsKeySchema.safeParse(key).success) continue;
      const entry = listColumnsEntrySchema.safeParse(value);
      if (!entry.success) continue;
      const hidden = [...new Set(entry.data.hidden)];
      if (hidden.length === 0 && Object.keys(entry.data.widths).length === 0) continue;
      lists[key] = { hidden, widths: entry.data.widths };
    }
    return Object.fromEntries(Object.entries(lists).slice(-MAX_LIST_COLUMN_LISTS));
  } catch {
    return {};
  }
}

// The PATCH's lists over the stored ones: null (or an empty entry) removes
// the list, anything else replaces it and moves it last — past the cap the
// lists changed longest ago go first.
export function mergeListColumns(
  stored: Record<string, ListColumnsEntry>,
  patch: Record<string, ListColumnsEntry | null>
): Record<string, ListColumnsEntry> {
  const next = { ...stored };
  for (const [key, entry] of Object.entries(patch)) {
    delete next[key];
    if (entry && (entry.hidden.length > 0 || Object.keys(entry.widths).length > 0)) {
      next[key] = { hidden: [...new Set(entry.hidden)], widths: entry.widths };
    }
  }
  return Object.fromEntries(Object.entries(next).slice(-MAX_LIST_COLUMN_LISTS));
}

function decodeDensity(raw: string | undefined): TableDensity {
  return (TABLE_DENSITIES as readonly string[]).includes(raw ?? "") ? (raw as TableDensity) : "normal";
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
      favoritesInSidebar: byKey.get(FAVORITES_IN_SIDEBAR_KEY) !== "false",
      overviewCards: decodeOverviewCards(byKey.get(OVERVIEW_CARDS_KEY)),
      density: decodeDensity(byKey.get(DENSITY_KEY)),
      listColumns: decodeListColumns(byKey.get(LIST_COLUMNS_KEY)),
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
      if (input.favoritesInSidebar !== undefined) {
        await repo.upsert(userId, FAVORITES_IN_SIDEBAR_KEY, String(input.favoritesInSidebar));
      }
      if (input.overviewCards !== undefined) {
        await repo.upsert(
          userId,
          OVERVIEW_CARDS_KEY,
          input.overviewCards === null ? "null" : JSON.stringify(input.overviewCards)
        );
      }
      if (input.density !== undefined) {
        await repo.upsert(userId, DENSITY_KEY, input.density);
      }
      if (input.listColumns !== undefined) {
        const patch = input.listColumns;
        await repo.updateValue(userId, LIST_COLUMNS_KEY, (raw) =>
          JSON.stringify(mergeListColumns(decodeListColumns(raw), patch))
        );
      }
      return getSettings(userId);
    },
  };
}

export type UserSettingsService = ReturnType<typeof createUserSettingsService>;
