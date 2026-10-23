// Colour themes. Each id here must have a matching :root[data-theme="<id>"]
// block in styles/tokens.css defining the full colour-token set — adding a
// theme is that block plus one entry below (theme-tokens.test.ts in
// apps/api/test checks the two stay in sync). The token set itself is the
// catalogue THEME_TOKENS in lib/themeCore.ts (a copy of
// packages/shared/src/theme-core.ts), with the built-in themes' values in
// BUILTIN_THEME_VALUES; custom themes are installed under System → Teman.
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

// Inlined into <head> by the root layout so the stored theme is applied
// before first paint — on every page, including those without the toggle
// (stämpelterminalen, login). An unknown stored id (a removed theme) falls
// back to the default. localStorage can throw (private mode, blocked site
// data), hence the try.
export const themeBootScript = `(function(){try{var t=localStorage.getItem(${JSON.stringify(
  THEME_STORAGE_KEY
)});if(${JSON.stringify(THEMES.map((t) => t.id))}.indexOf(t)>=0)document.documentElement.setAttribute("data-theme",t);}catch(e){}})();`;
