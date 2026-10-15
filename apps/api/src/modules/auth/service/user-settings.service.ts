import { DEFAULT_LIST_PAGE_SIZE, LIST_PAGE_SIZE_OPTIONS, type UpdateUserSettingsInput, type UserSettings } from "@navet/shared";
import type { UserSettingsRepository } from "../repository/user-settings.repository.js";

const LIST_PAGE_SIZE_KEY = "list_page_size";

const LIST_PAGE_SIZE_VALUES: readonly number[] = LIST_PAGE_SIZE_OPTIONS;

function isValidListPageSize(value: number): value is UserSettings["listPageSize"] {
  return LIST_PAGE_SIZE_VALUES.includes(value);
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
    return { listPageSize };
  }

  return {
    getSettings,

    async updateSettings(userId: string, input: UpdateUserSettingsInput): Promise<UserSettings> {
      if (input.listPageSize !== undefined) {
        await repo.upsert(userId, LIST_PAGE_SIZE_KEY, String(input.listPageSize));
      }
      return getSettings(userId);
    },
  };
}

export type UserSettingsService = ReturnType<typeof createUserSettingsService>;
