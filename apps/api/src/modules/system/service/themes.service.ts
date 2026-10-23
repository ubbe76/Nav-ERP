import { randomBytes } from "node:crypto";
import {
  alignThemeSource,
  BUILTIN_THEME_VALUES,
  BUILTIN_THEMES,
  buildThemeCss,
  buildThemeFile,
  fillThemeTokens,
  isBuiltinThemeId,
  MAX_CUSTOM_THEMES,
  normalizeThemeSource,
  THEME_KEY_PATTERN,
  validateTheme,
  type CreateThemeInput,
  type ThemeBoot,
  type ThemeBootEntry,
  type ThemeDetail,
  type ThemeFile,
  type ThemeListRow,
  type ThemeScheme,
  type ThemeValidationResult,
  type UpdateThemeInput,
} from "@navet/shared";
import type { AuditWriter } from "../repository/audit.repository.js";
import type { ThemeRow, ThemesRepository } from "../repository/themes.repository.js";
import { isUniqueViolation } from "./db-errors.js";
import { FALLBACK_DEFAULT_THEME } from "./theme-settings.js";
import {
  ThemeInvalidError,
  ThemeIsDefaultError,
  ThemeLimitError,
  ThemeNameTakenError,
  ThemeNotFoundError,
} from "./themes.errors.js";

// The two theme settings this service answers with — read from the system
// service so the keys and defaults live in one place (theme-settings.ts).
export interface ThemeSettingsReader {
  getSettings(): Promise<{ defaultTheme: string; themeChoiceLocked: boolean }>;
}

const newKey = () => `egen-${randomBytes(4).toString("hex")}`;

const iso = (date: Date | null) => (date ? date.toISOString() : null);

// The stored source as the editor's shape — anything unreadable is dropped
// rather than surfaced (it is only a convenience for reopening the editor).
const storedSource = (raw: unknown) => normalizeThemeSource(raw).source;

// Behöver ses över: the stored tokens no longer match the catalogue (a token
// was added — filled from its fallback — or removed), or the filled result
// no longer passes. Never stored: recomputed on every read.
function review(row: ThemeRow): ThemeValidationResult {
  return validateTheme({ name: row.name, scheme: row.scheme, tokens: row.tokens });
}

const needsReview = (result: ThemeValidationResult) => !result.ok || result.warnings.length > 0;

// The custom themes' CSS and the theme picker's list, built once and kept in
// memory until a write — GET /theme-boot runs on every page load. One cache
// per service, i.e. per buildApp.
export function createThemesService(deps: { repo: ThemesRepository; audit: AuditWriter; settings: ThemeSettingsReader }) {
  const { repo, audit, settings } = deps;
  let cache: Promise<{ css: string; entries: ThemeBootEntry[] }> | null = null;

  async function build() {
    // Only generated keys reach the CSS (the builder refuses anything else).
    const rows = (await repo.list()).filter((row) => THEME_KEY_PATTERN.test(row.key));
    return {
      css: buildThemeCss(rows),
      entries: [
        ...BUILTIN_THEMES.map((t) => ({ id: t.id, label: t.label, scheme: t.scheme, builtIn: true })),
        ...rows.map((row) => ({ id: row.key, label: row.name, scheme: row.scheme, builtIn: false })),
      ],
    };
  }

  function cached() {
    if (!cache) {
      const pending = build();
      cache = pending;
      // A failed build is not kept: the next request tries again.
      pending.catch(() => {
        if (cache === pending) cache = null;
      });
    }
    return cache;
  }

  // Called after every committed write.
  const invalidate = () => {
    cache = null;
  };

  function listRow(row: ThemeRow, usage: Map<string, number>, defaultTheme: string): ThemeListRow {
    return {
      id: row.id,
      key: row.key,
      name: row.name,
      scheme: row.scheme,
      builtIn: false,
      origin: row.source === null ? "uploaded" : "editor",
      needsReview: needsReview(review(row)),
      usedBy: usage.get(row.key) ?? 0,
      isDefault: row.key === defaultTheme,
      createdAt: iso(row.createdAt),
      updatedAt: iso(row.updatedAt),
    };
  }

  async function detail(row: ThemeRow): Promise<ThemeDetail> {
    const [usage, { defaultTheme }] = await Promise.all([repo.usage(), settings.getSettings()]);
    const result = review(row);
    return {
      ...listRow(row, usage, defaultTheme),
      tokens: result.errors.length === 0 ? result.tokens : fillThemeTokens(row.scheme, row.tokens).tokens,
      source: storedSource(row.source),
      warnings: [...result.warnings, ...result.errors],
      contrastFailures: result.contrastFailures,
    };
  }

  // A built-in theme's label can't be taken either: two "Mörkt" in the picker
  // would be indistinguishable.
  function assertNameFree(name: string) {
    if (BUILTIN_THEMES.some((t) => t.label.toLocaleLowerCase("sv") === name.toLocaleLowerCase("sv"))) {
      throw new ThemeNameTakenError(name);
    }
  }

  // The stored source always reproduces the stored tokens (alignThemeSource):
  // a hand-edited theme file, or tokens saved before deriveTheme was tuned,
  // reopen in the editor with exactly their colours. A source that can't be
  // made to is not stored at all.
  function validated(input: unknown): ThemeValidationResult & { scheme: ThemeScheme } {
    const result = validateTheme(input);
    if (!result.ok || !result.scheme) throw new ThemeInvalidError(result.errors, result.contrastFailures);
    assertNameFree(result.name);
    const source = result.source ? alignThemeSource(result.source, result.tokens) : null;
    return { ...result, scheme: result.scheme, source };
  }

  return {
    // GET /theme-boot. userTheme: undefined = no session (left out of the
    // answer), null = the user follows the company default. An id that no
    // longer exists answers as the default.
    async boot(userTheme?: string | null): Promise<ThemeBoot> {
      const [{ css, entries }, { defaultTheme, themeChoiceLocked }] = await Promise.all([cached(), settings.getSettings()]);
      const known = (id: string | null | undefined) => (id ? entries.some((e) => e.id === id) : false);
      const boot: ThemeBoot = {
        css,
        themes: entries,
        defaultTheme: known(defaultTheme) ? defaultTheme : FALLBACK_DEFAULT_THEME,
        locked: themeChoiceLocked,
      };
      if (userTheme !== undefined) boot.userTheme = known(userTheme) ? userTheme : null;
      return boot;
    },

    // POST /themes/validate — the upload preview; nothing is saved.
    validate(input: unknown): ThemeValidationResult {
      return validateTheme(input);
    },

    async list(): Promise<ThemeListRow[]> {
      const [rows, usage, { defaultTheme }] = await Promise.all([repo.list(), repo.usage(), settings.getSettings()]);
      const builtIn: ThemeListRow[] = BUILTIN_THEMES.map((t) => ({
        id: t.id,
        key: t.id,
        name: t.label,
        scheme: t.scheme,
        builtIn: true,
        origin: "builtin",
        needsReview: false,
        usedBy: usage.get(t.id) ?? 0,
        isDefault: t.id === defaultTheme,
        createdAt: null,
        updatedAt: null,
      }));
      return [...builtIn, ...rows.map((row) => listRow(row, usage, defaultTheme))];
    },

    async get(id: string): Promise<ThemeDetail> {
      const row = await repo.get(id);
      if (!row) throw new ThemeNotFoundError(id);
      return detail(row);
    },

    async create(input: CreateThemeInput, userId: string | null): Promise<ThemeDetail> {
      const result = validated(input);
      let row: ThemeRow | "limit" | undefined;
      // A generated key colliding with an existing one is astronomically
      // unlikely — but cheap to survive.
      for (let attempt = 0; row === undefined; attempt++) {
        try {
          row = await repo.create(
            { key: newKey(), name: result.name, scheme: result.scheme, tokens: result.tokens, source: result.source, userId },
            MAX_CUSTOM_THEMES
          );
        } catch (err) {
          if (isUniqueViolation(err, "themes_name_unique")) throw new ThemeNameTakenError(result.name);
          if (attempt < 2 && isUniqueViolation(err, "themes_key_unique")) continue;
          throw err;
        }
      }
      if (row === "limit") throw new ThemeLimitError(MAX_CUSTOM_THEMES);
      invalidate();
      await audit.log({
        entityType: "theme",
        entityId: row.name,
        action: "theme_created",
        detail: { key: row.key, scheme: row.scheme, origin: row.source === null ? "uploaded" : "editor" },
        userId,
      });
      return detail(row);
    },

    async update(id: string, input: UpdateThemeInput, userId: string | null): Promise<ThemeDetail> {
      const existing = await repo.get(id);
      if (!existing) throw new ThemeNotFoundError(id);
      const result = validated({
        name: input.name ?? existing.name,
        scheme: input.scheme ?? existing.scheme,
        tokens: input.tokens ?? existing.tokens,
        source: input.source !== undefined ? input.source : existing.source,
      });
      let row: ThemeRow | null;
      try {
        row = await repo.update(id, { name: result.name, scheme: result.scheme, tokens: result.tokens, source: result.source, userId });
      } catch (err) {
        if (isUniqueViolation(err, "themes_name_unique")) throw new ThemeNameTakenError(result.name);
        throw err;
      }
      if (!row) throw new ThemeNotFoundError(id);
      invalidate();
      const changedFields = (["name", "scheme", "tokens", "source"] as const).filter((key) => input[key] !== undefined);
      await audit.log({
        entityType: "theme",
        entityId: row.name,
        action: "theme_updated",
        detail: {
          key: row.key,
          changedFields,
          ...(existing.name !== row.name ? { before: { name: existing.name }, after: { name: row.name } } : {}),
        },
        userId,
      });
      return detail(row);
    },

    async remove(id: string, userId: string | null): Promise<void> {
      const result = await repo.delete(id);
      if (result.status === "not_found") throw new ThemeNotFoundError(id);
      if (result.status === "default") throw new ThemeIsDefaultError(result.row.name);
      invalidate();
      await audit.log({
        entityType: "theme",
        entityId: result.row.name,
        action: "theme_deleted",
        detail: { key: result.row.key, usersReset: result.usersReset },
        userId,
      });
    },

    // Exportera: the theme file, complete (missing tokens filled).
    async exportTheme(id: string): Promise<ThemeFile> {
      const row = await repo.get(id);
      if (!row) throw new ThemeNotFoundError(id);
      return buildThemeFile({
        name: row.name,
        scheme: row.scheme,
        tokens: fillThemeTokens(row.scheme, row.tokens).tokens,
        source: storedSource(row.source),
      });
    },

    exportBuiltinTheme(name: string): ThemeFile {
      const theme = BUILTIN_THEMES.find((t) => t.id === name);
      if (!theme || !isBuiltinThemeId(name)) throw new ThemeNotFoundError(name);
      return buildThemeFile({ name: theme.label, scheme: theme.scheme, tokens: BUILTIN_THEME_VALUES[name], source: null });
    },
  };
}

export type ThemesService = ReturnType<typeof createThemesService>;
