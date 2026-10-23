import { z } from "zod";
import type { ThemeContrastFailure, ThemeIssue, ThemeScheme, ThemeSource } from "./theme-core.js";

// Egna teman — the API bodies and answers around theme-core.ts. The bodies
// are only shape-checked here: validateTheme (theme-core) is the real check,
// run by the server on every write.

// A theme id as stored in a setting: a built-in id (light/dark/dracula) or a
// custom theme's generated key ("egen-" + 8 hex). Existence is checked by
// the service.
export const themeIdSchema = z.string().min(1).max(40).regex(/^[a-z0-9-]+$/);

// POST /themes — from an uploaded file or the editor, the same body. Other
// top-level fields (format, version, …) are dropped.
export const createThemeSchema = z.object({
  name: z.string().max(200),
  scheme: z.string().max(20),
  tokens: z.record(z.string(), z.unknown()),
  source: z.unknown().optional(),
});
export type CreateThemeInput = z.infer<typeof createThemeSchema>;

// PATCH /themes/:id — any subset; the merged theme is validated as a whole.
// tokens replaces the whole set, source: null clears it.
export const updateThemeSchema = createThemeSchema
  .partial()
  .refine((data) => Object.keys(data).length > 0, "At least one field must be provided");
export type UpdateThemeInput = z.infer<typeof updateThemeSchema>;

// POST /themes/validate — a parsed theme file (or the same body as POST).
export const validateThemeBodySchema = z.record(z.string(), z.unknown());

export interface ThemeBootEntry {
  // The data-theme value: a built-in id or a custom theme's key.
  id: string;
  label: string;
  scheme: ThemeScheme;
  builtIn: boolean;
}

// GET /theme-boot — public. userTheme only with a valid session (null = the
// company default).
export interface ThemeBoot {
  css: string;
  themes: ThemeBootEntry[];
  defaultTheme: string;
  locked: boolean;
  userTheme?: string | null;
}

export type ThemeOrigin = "builtin" | "uploaded" | "editor";

// GET /themes — the built-in themes first, then the custom ones by name.
// id is the uuid for a custom theme and the built-in id for a built-in one.
export interface ThemeListRow {
  id: string;
  key: string;
  name: string;
  scheme: ThemeScheme;
  builtIn: boolean;
  origin: ThemeOrigin;
  // Behöver ses över: the catalogue has grown (or changed) since the theme
  // was saved — fallbacks fill the gaps, and the contrast check runs again on
  // the filled result.
  needsReview: boolean;
  usedBy: number;
  isDefault: boolean;
  createdAt: string | null;
  updatedAt: string | null;
}

// GET /themes/:id — tokens filled from fallbacks where the stored set lacks
// one; warnings/contrastFailures are the review findings.
export interface ThemeDetail extends ThemeListRow {
  tokens: Record<string, string>;
  source: ThemeSource | null;
  warnings: ThemeIssue[];
  contrastFailures: ThemeContrastFailure[];
}
