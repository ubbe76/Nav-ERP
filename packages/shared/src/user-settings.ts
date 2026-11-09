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

// Översikten: which cards the user's start page shows and in what order.
// null = the standard (DEFAULT_OVERVIEW_CARDS); [] = none. The web mirror
// (apps/web/lib/overviewCards.ts) has the labels, widths and the page each
// card's Se alla opens — the card is offered to those who may open it.
export const OVERVIEW_CARDS = [
  "flow",
  "attention",
  "orders",
  "stock",
  "favorites",
  "deliveries",
  "arrivals",
  "capacity",
  "receivables",
  "payables",
  "quotes",
  "deviations",
] as const;
export type OverviewCard = (typeof OVERVIEW_CARDS)[number];
// The standard (overviewCards null): the four cards Översikten has always
// had — a card added later never appears for someone who did not pick it.
export const DEFAULT_OVERVIEW_CARDS: readonly OverviewCard[] = ["flow", "attention", "orders", "stock"];

export const overviewCardsSchema = z
  .array(z.enum(OVERVIEW_CARDS))
  .max(OVERVIEW_CARDS.length)
  .refine((list) => new Set(list).size === list.length, {
    message: "Samma kort kan bara väljas en gång",
  });

// Täthet (Nav som program, punkt 6): the row height of every table.
export const TABLE_DENSITIES = ["normal", "compact"] as const;
export type TableDensity = (typeof TABLE_DENSITIES)[number];
export const tableDensitySchema = z.enum(TABLE_DENSITIES);

// Kolumner (punkt 6): per list page (keyed by its path, e.g.
// "/forsaljning/ordrar") the columns the user hid and the widths they dragged
// (content px). Column keys are the web table's own `key`s; one that no
// longer exists is simply never matched. The web mirror is
// apps/web/lib/listColumns.ts.
export const MAX_LIST_COLUMN_LISTS = 100;
export const MAX_LIST_COLUMNS = 40;
export const LIST_COLUMN_MIN_WIDTH = 40;
export const LIST_COLUMN_MAX_WIDTH = 1600;
export const listColumnsKeySchema = z.string().regex(/^\/[a-z0-9/_-]{0,79}$/);
const columnKeySchema = z.string().min(1).max(60);
export const listColumnsEntrySchema = z
  .object({
    hidden: z.array(columnKeySchema).max(MAX_LIST_COLUMNS),
    widths: z
      .record(columnKeySchema, z.number().int().min(LIST_COLUMN_MIN_WIDTH).max(LIST_COLUMN_MAX_WIDTH))
      .refine((widths) => Object.keys(widths).length <= MAX_LIST_COLUMNS, { message: "För många kolumnbredder" }),
    // Kolumnordning: the movable columns' keys in the user's order (absent =
    // as built). Keys that no longer exist are ignored by the web.
    order: z.array(columnKeySchema).max(MAX_LIST_COLUMNS).optional(),
  })
  .strict();
export type ListColumnsEntry = z.infer<typeof listColumnsEntrySchema>;
export const listColumnsSchema = z
  .record(listColumnsKeySchema, listColumnsEntrySchema)
  .refine((lists) => Object.keys(lists).length <= MAX_LIST_COLUMN_LISTS, { message: "För många listor" });

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
  // Where the favourites show: false hides the sidebar's Favoriter group (the
  // Översikten card "favorites" shows them instead). Default true.
  favoritesInSidebar: z.boolean(),
  // Översikten's cards (see overviewCardsSchema); null = standard.
  overviewCards: overviewCardsSchema.nullable(),
  // Täthet; default normal.
  density: tableDensitySchema,
  // Kolumner per list page; {} = every list as built.
  listColumns: listColumnsSchema,
  // Flikar (Nav som program, punkt 5): documents open as tabs on a wide
  // screen. Default true.
  documentTabs: z.boolean(),
});
export type UserSettings = z.infer<typeof userSettingsSchema>;

// PATCH /me/settings — partial update, upsert per provided key. `.strict()`
// rejects unknown keys (400) rather than silently dropping them.
// listColumns is merged per list instead of replaced — two tabs adjusting
// two lists must not undo each other — and null resets that list.
export const updateUserSettingsSchema = userSettingsSchema
  .partial()
  .extend({
    listColumns: z
      .record(listColumnsKeySchema, listColumnsEntrySchema.nullable())
      .refine((lists) => Object.keys(lists).length <= MAX_LIST_COLUMN_LISTS, { message: "För många listor" })
      .optional(),
  })
  .strict();
export type UpdateUserSettingsInput = z.infer<typeof updateUserSettingsSchema>;
