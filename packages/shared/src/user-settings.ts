import { z } from "zod";

// Per-user preferences (auth module, `user_settings` KV table) — distinct
// from the system-wide system_settings module. First (and so far only) key
// is listPageSize: how many rows the register lists (Table + Pagination)
// show per page, a Monitor-style personal preference rather than a
// system-wide setting.
export const LIST_PAGE_SIZE_OPTIONS = [25, 50, 100, 250] as const;
export const DEFAULT_LIST_PAGE_SIZE: (typeof LIST_PAGE_SIZE_OPTIONS)[number] = 50;

const listPageSizeSchema = z.union(
  LIST_PAGE_SIZE_OPTIONS.map((value) => z.literal(value)) as [
    z.ZodLiteral<25>,
    z.ZodLiteral<50>,
    z.ZodLiteral<100>,
    z.ZodLiteral<250>,
  ]
);

// GET /me/settings — always returns every known key, defaults filled in.
export const userSettingsSchema = z.object({
  listPageSize: listPageSizeSchema,
  // System → Kom igång: this administrator hid the checklist on Översikten.
  hideOnboarding: z.boolean(),
});
export type UserSettings = z.infer<typeof userSettingsSchema>;

// PATCH /me/settings — partial update, upsert per provided key. `.strict()`
// rejects unknown keys (400) rather than silently dropping them.
export const updateUserSettingsSchema = userSettingsSchema.partial().strict();
export type UpdateUserSettingsInput = z.infer<typeof updateUserSettingsSchema>;
