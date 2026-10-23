// Colour themes. Each id here must have a matching :root[data-theme="<id>"]
// block in styles/tokens.css defining the full colour-token set — adding a
// theme is that block plus one entry below (theme-tokens.test.ts in
// apps/api/test checks the two stay in sync). The token set itself is the
// catalogue THEME_TOKENS in lib/themeCore.ts (a copy of
// packages/shared/src/theme-core.ts), with the built-in themes' values in
// BUILTIN_THEME_VALUES; custom themes are installed under System → Teman.
import { API_URL } from "./api";
import type { ThemeBoot } from "./types";

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
export async function fetchThemeBoot(cookieHeader: string | undefined): Promise<ThemeBoot> {
  try {
    const res = await fetch(`${process.env.INTERNAL_API_URL ?? API_URL}/api/v1/theme-boot`, {
      headers: cookieHeader ? { cookie: cookieHeader } : {},
      cache: "no-store",
      signal: AbortSignal.timeout(1000),
    });
    if (!res.ok) return FALLBACK_THEME_BOOT;
    const body = (await res.json()) as ThemeBoot;
    if (!Array.isArray(body.themes) || typeof body.css !== "string") return FALLBACK_THEME_BOOT;
    return body;
  } catch {
    return FALLBACK_THEME_BOOT;
  }
}

// JSON for embedding in an inline <script>: "<" escaped so no value (a theme
// name, say) can close the script element.
function embedJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

// Inlined into <head> by the root layout so the chosen theme is applied
// before first paint — on every page, including those without the toggle
// (stämpelterminalen, login). Order: locked ⇒ the company default; else the
// user's saved choice ⇒ this browser's localStorage ⇒ the default; an
// unknown id (a removed theme) falls through to the default, and finally to
// light. localStorage can throw (private mode, blocked site data), hence
// the try.
export function themeBootScript(boot: ThemeBoot): string {
  const data = {
    ids: boot.themes.map((t) => t.id),
    def: boot.defaultTheme,
    locked: boot.locked,
    user: boot.userTheme ?? null,
    key: THEME_STORAGE_KEY,
  };
  return `(function(){var d=${embedJson(data)};var ok=function(t){return typeof t==="string"&&d.ids.indexOf(t)>=0};var t=null;if(!d.locked){if(ok(d.user))t=d.user;else{try{var s=localStorage.getItem(d.key);if(ok(s))t=s}catch(e){}}}if(!t)t=ok(d.def)?d.def:"light";document.documentElement.setAttribute("data-theme",t)})();`;
}
