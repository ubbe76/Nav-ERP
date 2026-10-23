// Colour themes. Each id here must have a matching :root[data-theme="<id>"]
// block in styles/tokens.css defining the full colour-token set — adding a
// theme is that block plus one entry below (theme-tokens.test.ts in
// apps/api/test checks the two stay in sync). The token set itself is the
// catalogue THEME_TOKENS in lib/themeCore.ts (a copy of
// packages/shared/src/theme-core.ts), with the built-in themes' values in
// BUILTIN_THEME_VALUES; custom themes are installed under System → Teman.
import { API_URL } from "./api";
import type { ThemeBoot, ThemeBootClient } from "./types";

export const THEMES = [
  { id: "light", label: "Ljust" },
  { id: "dark", label: "Mörkt" },
  { id: "dracula", label: "Dracula" },
] as const;

export type ThemeId = (typeof THEMES)[number]["id"];

export const DEFAULT_THEME: ThemeId = "light";
export const THEME_STORAGE_KEY = "nav-erp-theme";

export function isThemeId(value: unknown): value is ThemeId {
  return THEMES.some((t) => t.id === value);
}

// The answer the root layout falls back to when GET /theme-boot can't be
// read: the built-in themes only, i.e. the behaviour before custom themes.
export const FALLBACK_THEME_BOOT: ThemeBoot = {
  css: "",
  themes: THEMES.map((t) => ({ id: t.id, label: t.label, scheme: t.id === "light" ? "light" : "dark", builtIn: true })),
  defaultTheme: DEFAULT_THEME,
  locked: false,
};

// Server-side read of GET /theme-boot with the request's cookie (so the
// user's own choice comes along). No page may stop working because themes
// couldn't be read: a slow or failing API gives the fallback after ~1 s.
// fetchImpl/timeoutMs are for the tests.
export async function fetchThemeBoot(
  cookieHeader: string | undefined,
  { fetchImpl = fetch, timeoutMs = 1000 }: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}
): Promise<ThemeBoot> {
  try {
    const res = await fetchImpl(`${process.env.INTERNAL_API_URL ?? API_URL}/api/v1/theme-boot`, {
      headers: cookieHeader ? { cookie: cookieHeader } : {},
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return FALLBACK_THEME_BOOT;
    const body = (await res.json()) as ThemeBoot;
    if (!Array.isArray(body.themes) || typeof body.css !== "string") return FALLBACK_THEME_BOOT;
    return body;
  } catch {
    return FALLBACK_THEME_BOOT;
  }
}

// THE rule for which theme is shown — the boot script runs it before first
// paint (as source text, see themeBootScript) and ThemeBootProvider runs it
// again whenever the boot data changes on the client (a client-side login,
// a new default, the lock, a deleted theme). Order: locked ⇒ the company
// default; else the user's saved choice ⇒ this browser's stored choice ⇒
// the default; an id that isn't in the list (a removed theme) falls
// through, and finally to light.
//
// Self-contained and plain ES5 on purpose: its source is inlined into the
// script, so it may not use anything from its module or need a helper.
export function selectTheme(
  ids: readonly string[],
  defaultTheme: string,
  locked: boolean,
  userTheme: string | null | undefined,
  stored: string | null
): string {
  var ok = function (id: unknown) {
    return typeof id === "string" && ids.indexOf(id) >= 0;
  };
  if (!locked) {
    if (ok(userTheme)) return userTheme as string;
    if (ok(stored)) return stored as string;
  }
  return ok(defaultTheme) ? defaultTheme : "light";
}

// This browser's stored choice; localStorage can throw (private mode,
// blocked site data).
export function readStoredTheme(): string | null {
  try {
    return window.localStorage.getItem(THEME_STORAGE_KEY);
  } catch {
    return null;
  }
}

// JSON for embedding in an inline <script>: "<" escaped so no value (a theme
// name, say) can close the script element.
function embedJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

// Inlined into <head> by the root layout so the chosen theme is applied
// before first paint — on every page, including those without the toggle
// (stämpelterminalen, login). The rule is selectTheme's own source.
export function themeBootScript(boot: ThemeBootClient): string {
  const data = {
    ids: boot.themes.map((t) => t.id),
    def: boot.defaultTheme,
    locked: boot.locked,
    user: boot.userTheme ?? null,
    key: THEME_STORAGE_KEY,
  };
  return `(function(){var d=${embedJson(data)};var s=null;try{s=localStorage.getItem(d.key)}catch(e){}document.documentElement.setAttribute("data-theme",(${selectTheme.toString()})(d.ids,d.def,d.locked,d.user,s))})();`;
}
