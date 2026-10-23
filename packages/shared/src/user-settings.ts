import { z } from "zod";
import { alertKindSchema } from "./alerts.js";
import { themeIdSchema } from "./themes.js";

// Per-user preferences (auth module, `user_settings` KV table) — distinct
// from the system-wide system_settings module. The first key was
// listPageSize: how many rows the register lists (Table + Pagination) show
// per page, a Monitor-style personal preference rather than a system-wide
// setting.
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

// Favoriter: the user's own shortcuts at the top of the sidebar — any page
// inside Nav (a function, a filtered list, a card) under the name the user
// gave it, in the order shown. PATCH replaces the whole list.
export const MAX_FAVORITES = 20;
export const FAVORITE_TITLE_MAX = 60;

// A path inside Nav only: one leading slash — never "//host" or "/\host",
// which a browser resolves to another site — and no whitespace, backslash or
// control characters.
const favoriteHrefSchema = z
  .string()
  .max(500)
  .regex(/^\/(?![/\\])[^\s\\\p{Cc}]*$/u);

export const favoriteSchema = z
  .object({
    href: favoriteHrefSchema,
    title: z.string().trim().min(1).max(FAVORITE_TITLE_MAX),
  })
  .strict();
export type Favorite = z.infer<typeof favoriteSchema>;

export const favoritesSchema = z
  .array(favoriteSchema)
  .max(MAX_FAVORITES)
  .refine((list) => new Set(list.map((f) => f.href)).size === list.length, {
    message: "Samma sida kan bara vara favorit en gång",
  });

// GET /me/settings — always returns every known key, defaults filled in.
export const userSettingsSchema = z.object({
  listPageSize: listPageSizeSchema,
  // System → Kom igång: this administrator hid the checklist on Översikten.
  hideOnboarding: z.boolean(),
  // Aviseringar: the daily e-mail digest is opt-in per user. alertDigestKinds
  // narrows it to some kinds; null = every kind the user may see. Kinds the
  // user may not see are ignored when the mail is built, never rejected —
  // the permission may change afterwards.
  alertDigest: z.boolean(),
  alertDigestKinds: z.array(alertKindSchema).nullable(),
  // Egna teman: the user's chosen theme (a built-in id or a custom theme's
  // key); null = the company default. Checked to exist on PATCH.
  theme: themeIdSchema.nullable(),
  // Favoriter (see favoriteSchema); [] = none yet.
  favorites: favoritesSchema,
});
export type UserSettings = z.infer<typeof userSettingsSchema>;

// PATCH /me/settings — partial update, upsert per provided key. `.strict()`
// rejects unknown keys (400) rather than silently dropping them.
export const updateUserSettingsSchema = userSettingsSchema.partial().strict();
export type UpdateUserSettingsInput = z.infer<typeof updateUserSettingsSchema>;
